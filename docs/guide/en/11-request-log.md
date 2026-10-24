# 11. Request log

[← FAQ](10-faq.md) · [Contents](README.md)

Click **Open request log (打开请求日志)** on the gateway page to inspect traffic through the local gateway. Use it to investigate errors, rate limits, latency and route changes. Statistics from ordinary tool logs remain on the [usage pages](03-usage.md).

## Filter and search

Choose the last hour, 24 hours, seven days or all retained records, then filter by client or agent, provider, model, status and duration. Status filters include success, errors, retried requests, 4xx, 429 rate limits and 5xx. Search can match a request ID, session, model or error.

The table shows time, client, requested and routed target, status, tokens, estimated cost, time to first token, duration and output speed. Unavailable metrics stay unavailable instead of becoming zero. The page also shows matching records, the number retained locally and the oldest retained time. **All** means the diagnostic records still retained on this device.

## Expand a request

Expand a row to inspect:

- **Attempt order:** one logical request may fail and then switch to another member; each attempt has its own result and usage.
- **Routing explanation:** why a member was selected and why others were skipped, cooling down or unsuccessful.
- **Tokens and estimated cost:** effective tokens are input plus output, with cache reads and writes separate. Cost uses the applicable historical rates in the local price table.
- **Context composition:** sizes and counts for system instructions, tool definitions, conversation history, tool results and attachments. These measurements do not reconstruct their content.
- **Request identifiers and errors:** information for correlating a request and its session and checking upstream failures.

Failed requests with zero tokens and attempts skipped by the gateway may still appear in diagnostics. Their presence does not mean they add effective usage. Older records without context measurements or routing explanations retain that unavailable state.

## Live tail and export

Enable **Live tail (实时尾随)** to refresh about every two seconds. Polling pauses while the window is hidden. Click the control again to stop following, or use **Refresh** to update the current result manually.

**Export CSV** generates a file using the current filters for offline analysis. Identifiers, models, providers and error metadata can reveal usage patterns, so review the file before sharing it.

## Retention and privacy

The log stores metadata such as time, status, model, usage, timing and context sizes. It does not save request or response content and cannot restore the original conversation.

Usage diagnostics rotate automatically on this device, retaining about 32 MB in total. Routing decisions rotate separately, so an older request may lose its routing explanation first. Older usage remains in ledger statistics, but request diagnostics are not a permanent archive.

There is no manual log-clearing button on this page. Automatic rotation bounds the diagnostic files. Clearing filters only resets the view; it does not delete logs or ledger data.
