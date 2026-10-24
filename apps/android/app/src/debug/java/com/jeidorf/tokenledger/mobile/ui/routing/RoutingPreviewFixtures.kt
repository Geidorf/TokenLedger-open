package com.jeidorf.tokenledger.mobile.ui.routing

import com.jeidorf.tokenledger.mobile.routing.RoutingSnapshots

/**
 * 路由页截图夹具：一份按契约 routing-snapshot-v1 写的云端返回体，时间钉死，不读墙上时钟。
 * 只用于预览与截图测试；名字与数字都是演示数据，不对应真实账号。
 */
internal enum class RoutingPreviewKind { Live, NoSnapshot, Offline, NotDeployed }

private const val PREVIEW_SERVER_NOW = "2026-10-24T07:00:06Z"

private val LIVE_FLOWS = """
[
 {"id":"00000000000000a1","source":"external","agent":"claude-code","via":"group/long-context","phase":"inflight","at":"2026-10-24T07:00:01Z","waitingOn":"upstream","hops":[{"target":"deepseek/deepseek-chat","outcome":"pending"}]},
 {"id":"00000000000000a2","source":"external","agent":"opencode","via":"group/long-context","phase":"inflight","at":"2026-10-24T07:00:02Z","waitingOn":"upstream","hops":[{"target":"openrouter/gemini-2.5-pro","outcome":"pending"}]},
 {"id":"00000000000000a3","source":"tokenledger","agent":"codex","via":"group/long-context","phase":"routed","at":"2026-10-24T06:59:58Z","hops":[{"target":"moonshot/kimi-k2","outcome":"failed","status":429},{"target":"zhipu/glm-4.6","outcome":"ok"}]},
 {"id":"00000000000000a4","source":"tokenledger","agent":"gemini","via":"group/long-context","phase":"done","at":"2026-10-24T06:59:31Z","hops":[{"target":"anthropic/claude-sonnet-4-5","outcome":"ok"}]},
 {"id":"00000000000000a5","source":"tokenledger","agent":"codex","via":"gpt-5","phase":"failed","at":"2026-10-24T06:58:12Z","hops":[{"target":"openai/gpt-5","outcome":"failed","status":503}]}
]
""".trimIndent()

private val OFFLINE_FLOWS = """
[
 {"id":"00000000000000b1","source":"tokenledger","agent":"codex","via":"group/coding","phase":"done","at":"2026-10-24T06:52:40Z","hops":[{"target":"deepseek/deepseek-chat","outcome":"ok"}]}
]
""".trimIndent()

private fun envelope(receivedAt: String, flows: String) = """
{"serverTime":"$PREVIEW_SERVER_NOW","snapshots":[{"device":"0123456789abcdef0123456789abcdef","receivedAt":"$receivedAt",
 "snapshot":{"v":1,"generatedAt":"$receivedAt","sources":[{"id":"tokenledger","reachable":true},{"id":"external","reachable":true}],"flows":$flows}}]}
""".trimIndent()

internal fun routingPreviewFeed(kind: RoutingPreviewKind): RoutingFeed {
    val now = RoutingSnapshots.parseTime(PREVIEW_SERVER_NOW) ?: 0L
    return when (kind) {
        RoutingPreviewKind.Live -> RoutingFeed(
            signedIn = true,
            result = RoutingSnapshots.parse(envelope("2026-10-24T07:00:03Z", LIVE_FLOWS)),
            fixedNowServerMs = now
        )
        RoutingPreviewKind.Offline -> RoutingFeed(
            signedIn = true,
            result = RoutingSnapshots.parse(envelope("2026-10-24T06:53:00Z", OFFLINE_FLOWS)),
            fixedNowServerMs = now
        )
        RoutingPreviewKind.NoSnapshot -> RoutingFeed(
            signedIn = true,
            result = RoutingSnapshots.parse("""{"serverTime":"$PREVIEW_SERVER_NOW","snapshots":[]}"""),
            fixedNowServerMs = now
        )
        RoutingPreviewKind.NotDeployed -> RoutingFeed(
            signedIn = true,
            failure = com.jeidorf.tokenledger.mobile.routing.RoutingReadFailure.NotDeployed,
            fixedNowServerMs = now
        )
    }
}
