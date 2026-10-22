package com.jeidorf.tokenledger.mobile

import android.content.Context
import android.content.SharedPreferences
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import android.util.Log
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

internal class SessionStore internal constructor(
    private val prefs: SharedPreferences,
    private val testCipher: QuotaCacheCipher? = null
) : SessionPersistence {
    constructor(context: Context) : this(
        context.applicationContext.getSharedPreferences("tokenledger_mobile_session", Context.MODE_PRIVATE)
    )

    fun load(): MobileSession? = synchronized(STORE_LOCK) {
        checkHealthy()
        loadLocked()
    }

    override fun generation(): Long = synchronized(STORE_LOCK) {
        checkHealthy()
        prefs.getLong(KEY_GENERATION, 0L)
    }

    override fun snapshot(): SessionSnapshot = synchronized(STORE_LOCK) {
        checkHealthy()
        SessionSnapshot(prefs.getLong(KEY_GENERATION, 0L), loadLocked())
    }

    private fun loadLocked(): MobileSession? {
        val iv = prefs.getString(KEY_IV, null) ?: return null
        val payload = prefs.getString(KEY_PAYLOAD, null) ?: return null
        return runCatching {
            val decrypted = if (testCipher != null) {
                testCipher.decrypt(KEY_PAYLOAD, payload).toByteArray(Charsets.UTF_8)
            } else {
                val cipher = Cipher.getInstance(TRANSFORMATION)
                cipher.init(
                    Cipher.DECRYPT_MODE,
                    getOrCreateSecretKey(),
                    GCMParameterSpec(GCM_TAG_BITS, Base64.decode(iv, Base64.NO_WRAP))
                )
                cipher.doFinal(Base64.decode(payload, Base64.NO_WRAP))
            }
            val json = JSONObject(String(decrypted, Charsets.UTF_8))
            MobileSession(
                accessToken = json.optString("accessToken"),
                refreshToken = json.optString("refreshToken"),
                userId = json.optString("userId"),
                email = json.optString("email"),
                expiresAtEpochSeconds = json.longValue("expiresAtEpochSeconds")
            )
        }.getOrElse { error ->
            // Distinguish "no session" (handled above) from "session present but undecryptable"
            // (e.g. an intermittent Keystore failure). Logged so the drop-to-login can be traced. (T7.7)
            Log.w(TAG, "session_decrypt_failed", error)
            null
        }
    }

    override fun activate(expectedGeneration: Long, session: MobileSession): Boolean = synchronized(STORE_LOCK) {
        checkHealthy()
        if (prefs.getLong(KEY_GENERATION, 0L) != expectedGeneration) return@synchronized false
        val generation = nextGeneration()
        writeSession(session, generation)
        true
    }

    override fun replace(expected: SessionSnapshot, session: MobileSession): Boolean = synchronized(STORE_LOCK) {
        checkHealthy()
        if (prefs.getLong(KEY_GENERATION, 0L) != expected.generation ||
            loadLocked() != expected.session || expected.session?.userId != session.userId
        ) return@synchronized false
        writeSession(session, expected.generation)
        true
    }

    override fun writeIfCurrent(expected: SessionSnapshot, write: () -> Unit): Boolean = synchronized(STORE_LOCK) {
        checkHealthy()
        // Tokens may rotate within this lifecycle; logout and every activation advance it.
        if (expected.session == null || prefs.getLong(KEY_GENERATION, 0L) != expected.generation ||
            loadLocked()?.userId != expected.session.userId
        ) return@synchronized false
        write()
        true
    }

    private fun writeSession(session: MobileSession, generation: Long) {
        val json = JSONObject()
            .put("accessToken", session.accessToken)
            .put("refreshToken", session.refreshToken)
            .put("userId", session.userId)
            .put("email", session.email)
            .put("expiresAtEpochSeconds", session.expiresAtEpochSeconds)

        val (iv, payload) = if (testCipher != null) {
            "fixture" to testCipher.encrypt(KEY_PAYLOAD, json.toString())
        } else {
            val cipher = Cipher.getInstance(TRANSFORMATION)
            cipher.init(Cipher.ENCRYPT_MODE, getOrCreateSecretKey())
            val encrypted = cipher.doFinal(json.toString().toByteArray(Charsets.UTF_8))
            Base64.encodeToString(cipher.iv, Base64.NO_WRAP) to Base64.encodeToString(encrypted, Base64.NO_WRAP)
        }
        // commit(): synchronous write so a rotated refresh token is on disk before the caller
        // proceeds; session writes are infrequent, so there is no throughput concern. (T7.7)
        val committed = prefs.edit()
            .putLong(KEY_GENERATION, generation)
            .putString(KEY_IV, iv)
            .putString(KEY_PAYLOAD, payload)
            .commit()
        if (!committed) {
            uncommittedState = true
            error("会话未可靠落盘，需重新登录或重试退出")
        }
    }

    override fun revoke(): SessionSnapshot = synchronized(STORE_LOCK) {
        val generation = nextGeneration()
        val committed = prefs.edit()
            .putLong(KEY_GENERATION, generation)
            .remove(KEY_IV)
            .remove(KEY_PAYLOAD)
            .commit()
        if (!committed) {
            uncommittedState = true
            error("退出登录未可靠落盘，请重试")
        }
        uncommittedState = false
        SessionSnapshot(generation, null)
    }

    fun clear() { revoke() }

    private fun nextGeneration(): Long {
        val current = prefs.getLong(KEY_GENERATION, 0L)
        check(current < Long.MAX_VALUE) { "会话代次已耗尽" }
        return current + 1L
    }

    private fun checkHealthy() {
        check(!uncommittedState) { "会话存储落盘失败，请重新登录或重试退出" }
    }

    private fun getOrCreateSecretKey(): SecretKey {
        val keyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }
        val existing = keyStore.getEntry(KEY_ALIAS, null) as? KeyStore.SecretKeyEntry
        if (existing != null) return existing.secretKey

        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
        val spec = KeyGenParameterSpec.Builder(
            KEY_ALIAS,
            KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT
        )
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setRandomizedEncryptionRequired(true)
            .build()
        generator.init(spec)
        return generator.generateKey()
    }

    private companion object {
        val STORE_LOCK = Any()
        var uncommittedState = false
        const val TAG = "SessionStore"
        const val ANDROID_KEYSTORE = "AndroidKeyStore"
        const val KEY_ALIAS = "tokenledger_mobile_session_key"
        const val KEY_IV = "session_iv"
        const val KEY_PAYLOAD = "session_payload"
        const val KEY_GENERATION = "session_generation"
        const val TRANSFORMATION = "AES/GCM/NoPadding"
        const val GCM_TAG_BITS = 128
    }
}
