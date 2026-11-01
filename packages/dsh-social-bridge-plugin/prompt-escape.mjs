// 提示词里未受信任文本的转义：只挡住能伪装成标记的字符引用，别把链接改坏。
//
// 旧规则把每一个 & 都转成 &amp;，于是聊天里的 URL 变成
// https://mp.weixin.qq.com/s?__biz=..&amp;mid=..——微信文章必需的
// mid/idx/sn/chksm 参数名被读成 "amp;mid"，链接直接失效。
//
// 新规则只在 & 后面跟着能解码成 < 或 > 的实体时转义它：
//   &lt; &gt; &#60; &#62; &#x3c; &#x3e;（含无分号写法）
// 这类才是真能越出 <untrusted_chat> 边界的字符；其余的 &（URL 查询分隔符、
// 未知实体）转义与否都不影响边界安全，双写防护强度与旧规则一致。
const ENTITY_ANGLE = /&(?=(?:lt|gt|#0*60|#0*62|#x0*3c|#x0*3e)(?![\w=]))/gi;

export function escapePromptText(value) {
  return String(value ?? '')
    .replace(ENTITY_ANGLE, '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;');
}

export default escapePromptText;
