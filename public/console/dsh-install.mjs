export const DSH_SDK_VERSION = '0.2.0-rc.2';
export const DSH_INSTALL_URL = 'https://www.deepseek.com/harness/';

export function dshInstallCard({ header, field, pluginPathField }) {
  return `<section class="card setup-dsh-card">${header('安装并连接 DSH', 'DSH 需要单独安装，WeChatAgent 不再内置。', '', 'plug')}<p class="modal-description">先从官方页面下载并安装 DSH（当前插件验证版本 ${DSH_SDK_VERSION}），登录自己的模型账号。已有 DSH 可直接使用。</p><div class="button-row"><a class="button" href="${DSH_INSTALL_URL}" target="_blank" rel="noopener noreferrer">下载安装 DSH</a></div><div class="space-top">${field('DSH 程序位置', 'runtime.dshDesktop', { full: true, browse: 'exe', placeholder: '选择已安装的 DeepSeek Harness.exe', help: '选择后先保存设置，再点击“打开 DSH”。' })}</div><p class="modal-description space-top">在 DSH 插件页面添加下方本机插件目录并启用，再从托盘完整退出并重新打开 DSH。</p>${pluginPathField()}<div class="button-row space-top"><button class="button" data-action="dsh-open">打开 DSH</button><button class="button" id="open-plugin-folder">打开插件目录</button></div></section>`;
}
