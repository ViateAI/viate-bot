const hint = document.getElementById("hint");
const error = document.getElementById("error");
const form = document.getElementById("form");
const base = document.getElementById("base");
const submit = document.getElementById("submit");

window.viateDesktop.getState().then((state) => {
  if (!hint || !base) return;
  hint.textContent = state.dev
    ? "填写 https:// 地址。开发构建也接受 http://127.0.0.1 和 http://localhost。"
    : "填写这个站点的 https:// 地址。";
  if (state.baseUrl) base.value = state.baseUrl;
});

form?.addEventListener("submit", (event) => {
  event.preventDefault();
  if (!base || !submit || !error) return;
  submit.disabled = true;
  error.textContent = "正在打开浏览器，请在页面上允许这台电脑。";
  void window.viateDesktop.setBase(base.value).then((result) => {
    submit.disabled = false;
    if (!result.ok) error.textContent = result.error;
  });
});
