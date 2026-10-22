package com.jeidorf.tokenledger.mobile

import com.jeidorf.tokenledger.mobile.ui.foundation.v2QuotaReason
import java.io.File
import org.junit.Assert.*
import org.junit.Test

class ExperimentalConsentReasonTest {
    private fun provider(): QuotaProviderEnvelope =
        QuotaSnapshotJson.parseFixtureProviders(File("../../../fixtures/quota-provider-v1/complete-v1.json").readText(), QuotaParseMode.OrdinaryReader).first()

    @Test fun experimentalConsentRequiredIsLocalizedInsteadOfFallback() {
        val reason = v2QuotaReason("experimental_consent_required", QuotaScope.ConsumerSubscription)
        assertEquals("需要在桌面端确认实验性风险提示", reason)
        assertNotEquals(v2QuotaReason("unregistered_reason_code"), reason)
    }

    @Test fun experimentalConsentRequiredPointsToDesktopRiskConfirmation() {
        val provider = provider().copy(status = QuotaProviderStatus.AuthRequired, reasonCode = "experimental_consent_required", windows = emptyList())
        val guidance = quotaRecoveryGuidance(provider)
        assertTrue(guidance.contains("确认风险提示"))
        assertNotEquals(quotaRecoveryGuidance(provider.copy(reasonCode = "unregistered_reason_code")), guidance)
    }
}
