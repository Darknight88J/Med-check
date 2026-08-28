# Med check — Web Push 后端

让「Med check」在 **App 关闭 / 后台** 时也能在到点收到系统通知（真正的推送，而不是只能前台弹闹钟）。

> 纯前端离线 PWA 的定时器在 App 进后台/被关掉后会被系统挂起，所以「关掉也响」必须靠一个推送后端：后端在到点时向 Apple/Google 推送服务发一条 Web Push，由系统把通知送到手机。

## 文件
- `push-server.mjs` — 后端（Node 内置 http，无框架依赖）
- `package.json` — 启动脚本 + 依赖
- `.vapid.json` — 已生成的 VAPID 密钥（推送身份，部署时一起带上）
- `subs.json` — 运行期自动生成的订阅库（演示用，生产建议换数据库）

## 本地跑（先验证）
```bash
cd server
npm install
PORT=8787 node push-server.mjs
# 健康检查:  curl http://127.0.0.1:8787/health
# 公钥:      curl http://127.0.0.1:8787/api/vapid
```

## 部署到常驻公网（推荐 Railway，免费额度够用）
> 沙箱环境会休眠、也没有稳定公网地址，所以**生产请用下面的常驻主机**。任选其一。

### 方式 A：Railway
1. 打开 https://railway.app ，用 GitHub 登录，「New Project → Deploy from GitHub repo」（把本仓库推到 GitHub 后选它）；或「Empty Project」后用 `railway up` CLI 部署 `server/` 目录。
2. 在 Project 的 Variables 里加 `PORT = 8787`（Railway 也会自动注入）。
3. 确保 `.vapid.json` 和 `push-server.mjs`、`package.json` 一起被部署。
4. 部署完成后 Railway 会给你一个 `https://xxx.up.railway.app` 的公网 HTTPS 地址。记下它。

### 方式 B：Render
1. 打开 https://render.com ，「New → Web Service」，连 GitHub 仓库。
2. Root Directory 指向 `server/`，Build Command `npm install`，Start Command `node push-server.mjs`。
3. 部署完成后得到 `https://xxx.onrender.com` 地址。

## 把后端地址填回 App
部署拿到后端 HTTPS 地址（例如 `https://xxx.up.railway.app`）后：
1. 打开 `/workspace/index.html`（由 `build-inline.mjs` 生成），把
   ```html
   <meta name="medcheck-push-api" content="" />
   ```
   改成你的地址（结尾不要带 `/`）：
   ```html
   <meta name="medcheck-push-api" content="https://xxx.up.railway.app" />
   ```
2. 如果是从源码构建，改 `build-inline.mjs` 里同一行 meta 再跑 `node build-inline.mjs`。
3. 重新发布 App（「发布为应用」）或重新生成 `med-check-netlify.zip` 上传 Netlify。

## 手机上第一次使用（iOS 注意）
1. 用 Safari 把 App（gz4.agentos-app.net）**「添加到主屏幕」**装成 PWA —— 系统级 Web Push 只在已安装的 PWA 上生效。
2. 需要 **iOS 16.4 以上**。
3. 打开 App → 设置 → 通知权限 → 点「开启通知」（会弹系统授权，允许）。
4. 设置 → 按时间提醒 → 给某个时段打开「推送通知」开关 → 保存。
5. 之后即使锁屏/切后台/短暂关掉 App，到点也会收到系统通知。

## 原理
- 客户端在用户允许通知后，用 `pushManager.subscribe` 生成订阅，连同「每时段提醒时间 + 时区偏移」POST 给后端存起来。
- 后端每 30 秒扫一次：对每台设备，若「用户本地时间」已到某时段且当天未推过，就 `web-push.sendNotification` 推一条。
- 订阅失效（404/410）自动清理。
- SW（`/workspace/sw.js`）里有 `push` / `notificationclick` 处理：收到推送弹系统通知，点击回到 App。

## 说明 / 边界
- 后端目前用 `subs.json` 文件存储，演示/单人够用；多用户或要持久化请换数据库。
- `TTL: 0`：仅在点到的那一刻送达（不缓存补发）。
- 后端必须 **HTTPS** 且公网可达；本沙箱仅用于开发验证，不能作生产。
