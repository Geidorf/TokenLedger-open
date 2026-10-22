package com.jeidorf.tokenledger.mobile.ui.details

import androidx.compose.foundation.background
import androidx.compose.foundation.layout.Box
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.heightIn
import androidx.compose.foundation.layout.padding
import androidx.compose.foundation.layout.size
import androidx.compose.foundation.layout.width
import androidx.compose.foundation.shape.RoundedCornerShape
import androidx.compose.foundation.text.BasicTextField
import androidx.compose.foundation.text.KeyboardActions
import androidx.compose.foundation.text.KeyboardOptions
import androidx.compose.material.icons.Icons
import androidx.compose.material.icons.filled.Search
import androidx.compose.material3.Icon
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.runtime.Composable
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Alignment
import androidx.compose.ui.Modifier
import androidx.compose.ui.draw.clip
import androidx.compose.ui.semantics.contentDescription
import androidx.compose.ui.semantics.semantics
import androidx.compose.ui.text.TextStyle
import androidx.compose.ui.text.input.ImeAction
import androidx.compose.ui.unit.dp
import com.jeidorf.tokenledger.mobile.LedgerFont
import com.jeidorf.tokenledger.mobile.ui.foundation.MobileV2Palette
import com.jeidorf.tokenledger.mobile.ui.foundation.V2_ICON_INLINE

@Composable
internal fun V2DetailSearch(
    palette: MobileV2Palette,
    current: String?,
    onSearchChange: (String?) -> Unit
) {
    var draft by remember(current) { mutableStateOf(current.orEmpty()) }
    Row(
        modifier = Modifier
            .fillMaxWidth()
            .heightIn(min = 50.dp)
            .clip(RoundedCornerShape(13.dp))
            .background(palette.surface)
            .padding(start = 12.dp, end = 6.dp),
        verticalAlignment = Alignment.CenterVertically
    ) {
        Icon(Icons.Default.Search, contentDescription = null, tint = palette.faint, modifier = Modifier.size(V2_ICON_INLINE))
        Spacer(Modifier.width(8.dp))
        Box(Modifier.weight(1f)) {
            if (draft.isEmpty()) Text("搜索工具、模型、设备或会话", color = palette.faint, fontSize = LedgerFont.caption)
            BasicTextField(
                value = draft,
                onValueChange = { draft = it },
                modifier = Modifier
                    .fillMaxWidth()
                    .semantics {
                        contentDescription = "搜索消耗明细，支持工具、模型、设备或会话"
                    },
                singleLine = true,
                textStyle = TextStyle(color = palette.text, fontSize = LedgerFont.label),
                keyboardOptions = KeyboardOptions(imeAction = ImeAction.Search),
                keyboardActions = KeyboardActions(
                    onSearch = { onSearchChange(draft.trim().ifEmpty { null }) }
                )
            )
        }
        TextButton(onClick = { onSearchChange(draft.trim().ifEmpty { null }) }, modifier = Modifier.heightIn(min = 48.dp)) {
            Text("应用", color = palette.blue, fontSize = LedgerFont.caption)
        }
    }
}
