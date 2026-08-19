const menuButton = document.querySelector('.menu-button');
const navigation = document.querySelector('#site-nav');

menuButton?.addEventListener('click', () => {
  const open = navigation.classList.toggle('open');
  menuButton.setAttribute('aria-expanded', String(open));
});

navigation?.addEventListener('click', () => {
  navigation.classList.remove('open');
  menuButton?.setAttribute('aria-expanded', 'false');
});

const messages = document.querySelector('#demo-messages');
const options = document.querySelector('#demo-options');
const restart = document.querySelector('#restart-demo');

function addMessage(kind, label, text) {
  const wrapper = document.createElement('div');
  wrapper.className = `message ${kind}`;
  const name = document.createElement('span');
  name.textContent = label;
  const body = document.createElement('p');
  body.textContent = text;
  wrapper.append(name, body);
  messages.append(wrapper);
}

function runDemo(answer) {
  options.hidden = true;
  if (answer === 'domain') {
    addMessage('user', '用户选择', '配置域名');
    addMessage('helper', '部署程序', '下一步需要填写域名，并选择是否配置 Nginx 和免费的 HTTPS 证书。相关操作将在执行前再次请求确认。');
  } else {
    addMessage('user', '用户选择', '不配置域名，使用服务器 IP');
    addMessage('helper', '部署程序', '程序将跳过 Nginx 和 HTTPS 配置，并在部署完成后显示“服务器 IP + 应用端口”形式的访问地址。');
  }
  addMessage('helper', '部署程序', '当前选择已保存。终端关闭后，再次运行程序可从已保存步骤继续。');
  restart.hidden = false;
}

options?.addEventListener('click', event => {
  const button = event.target.closest('button[data-answer]');
  if (button) runDemo(button.dataset.answer);
});

restart?.addEventListener('click', () => {
  messages.innerHTML = '<div class="message helper"><span>部署程序</span><p>是否需要为当前项目配置域名？如果没有域名，可使用服务器 IP 和应用端口访问。</p></div>';
  options.hidden = false;
  restart.hidden = true;
});

document.querySelector('#copy-command')?.addEventListener('click', async event => {
  const button = event.currentTarget;
  try {
    await navigator.clipboard.writeText(button.dataset.copy);
    button.textContent = '命令已复制，可粘贴到终端';
  } catch {
    button.textContent = '复制失败，请手动选择上方命令';
  }
  window.setTimeout(() => { button.textContent = '复制安装命令'; }, 2500);
});
