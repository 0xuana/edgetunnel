# Xuana VLESS Worker

这是独立实现的 Cloudflare Worker，提供 **VLESS over WebSocket、TCP 转发、SOCKS5 出口、VLESS 订阅和自定义优选入口**。`/admin` 管理页可以查看订阅地址；绑定 KV 后，还能在线保存优选入口。只想使用 VLESS 订阅时，**不需要 KV**。

本文说明的是本目录的新实现，**不是仓库根目录原版 `_worker.js` 的配置手册**。旧版的 `KEY`、`KV`、`GO2SOCKS5` 等变量不能原样套用；新实现的完整变量表见下文。该版本面向 **Cloudflare Workers**，不要按原仓库的 Pages 上传教程部署。

## 功能与文件选择

| 文件 | 用途 | 部署方式 |
| --- | --- | --- |
| [根目录 `源码.js`](../源码.js) | 所有代码和管理页都在一个文件里，**没有任何 `import`** | 在 Workers 网页编辑器中完整复制、粘贴、部署；适合只复制一个文件的方式 |
| [`worker.js`](./worker.js) | 同一功能的单文件版本，使用 Cloudflare 官方 `cloudflare:sockets` 内置模块 | 网页编辑器或本目录的 Wrangler 配置 |
| `src/` | 维护用的模块源码 | 修改后构建，不要只复制其中一个模块部署 |

`源码.js` 通过 workerd 的 `request.fetcher.connect` 发起 TCP 连接；本地 Miniflare/workerd 测试已验证 TCP 和 SOCKS5 双向转发，但这个接口不在 Cloudflare 公开 TCP API 文档中。若部署环境无法提供此接口，请改用带 `cloudflare:sockets` 内置导入的 `worker.js`。两份部署文件由同一套源码生成；它们**都不需要**旧版 `_worker.js` 的混淆字典。

本版支持的 UDP 仅为 **VLESS UDP 端口 53 的 DNS 查询**，经 DNS-over-HTTPS 发送。其他 UDP、QUIC、MUX、Reality、Vision、gRPC、XHTTP、Trojan、Shadowsocks 以及原版的其他扩展功能不在此版本范围内。

## 从零部署到 Workers

1. 在 Cloudflare 的 **Workers & Pages** 中创建一个 Worker，打开代码编辑器，用根目录 [`源码.js`](../源码.js) 的**全部内容**替换默认示例代码。编辑器里出现“预览”内容，只代表预览环境的响应；还需要点击 **Deploy / 部署**，让新版本成为生产环境的 Active 版本。
2. 按下一节的命令生成 `UUID`、`SUB_TOKEN`、`ADMIN`，把输出值分别填入 Worker **生产环境**的同名机密变量。`UUID` 是唯一必填项；不要使用文档中的示例 UUID。
3. 建议分别设置 `SUB_TOKEN`（访问订阅的令牌）和 `ADMIN`（`/admin` 登录密码）。两者都可省略，但省略时会依次回退，详见变量表。
4. 按需要添加 `SOCKS5`、`ADDRESSES` 等可选变量。只有需要在网页管理页**保存**优选列表时才创建或选用 KV 命名空间，并把 Worker 中的 **绑定变量名**写成 `SETTINGS`。命名空间自己的名称可以任意。
5. 保存配置并部署到生产环境。打开 `https://你的-workers.dev-域名/health`，再用真实 `SUB_TOKEN` 测试 `/sub?token=...&format=raw`，最后在客户端导入订阅并实际连接。`/health` 成功不等于变量、KV 或 TCP 出口可用。
6. 如需自定义域名，在这个 Worker 的域名/路由设置中添加并启用，再用该域名重复第 5 步。订阅中的 TLS SNI 和 WebSocket Host 默认取访问订阅时的域名；要固定成自己的域名，可设置 `HOST`。只配置 DNS 而没有让请求进入 Worker 时，代码本身无法处理该域名。

`/admin` 页面本身不做配置检查，所以**页面能打开、预览能显示，也不证明生产部署或变量正确**。以生产域名的订阅响应和客户端实际连接为准。预览环境与生产环境可能使用不同的变量及绑定；检查配置时要看生产环境。

### 生成 UUID、订阅令牌和管理密码

在自己的终端运行下面一条命令；需要 Python 3，无需安装额外软件包：

```sh
python3 -c 'import uuid, secrets; print("UUID=" + str(uuid.uuid4())); print("SUB_TOKEN=" + secrets.token_urlsafe(32)); print("ADMIN=" + secrets.token_urlsafe(32))'
```

命令每运行一次都会生成一组新值。

| 输出项 | 填写位置 | 作用 |
| --- | --- | --- |
| `UUID=...` | Cloudflare Worker 生产环境的 `UUID` 机密变量；只复制等号右边的值 | VLESS 客户端身份，必须与节点配置中的 UUID 一致 |
| `SUB_TOKEN=...` | 同名 `SUB_TOKEN` 机密变量；只复制值 | `/sub?token=...` 使用的订阅令牌；命令生成约 43 个字符，符合 16–256 字符要求 |
| `ADMIN=...` | 同名 `ADMIN` 机密变量；只复制值 | `/admin` 管理页登录密码，与订阅令牌分别生成 |

如果只想生成必填的 UUID，可以运行 `python3 -c 'import uuid; print(uuid.uuid4())'`。不配置 `SUB_TOKEN` 时，它默认等于 UUID；不配置 `ADMIN` 时，它默认等于 `SUB_TOKEN`，若两者都未配置则也等于 UUID。推荐配置三个不同的值，不要把生成结果提交到 Git 或发给别人。更换 UUID 后旧客户端节点需要更新；更换 `SUB_TOKEN` 后订阅地址需要更新；更换 `ADMIN` 后使用新密码登录。`SOCKS5` 的地址和账号密码由你的代理服务提供，不能用上述命令替代。

### 最小配置

```text
UUID=你生成的规范UUID
```

此时 `SUB_TOKEN` 默认等于 UUID，`ADMIN` 默认也等于 UUID；订阅入口默认使用当前请求域名，TCP 默认直接连接目标。可以访问 `/admin` 查看订阅，但没有 `SETTINGS` KV 时不能在线保存入口列表。实际使用建议为订阅和管理页分别配置独立机密。

### 常用配置示例

```text
UUID=你生成的规范UUID
SUB_TOKEN=一个至少16字符的随机订阅令牌
ADMIN=另一个独立的管理密码
HOST=worker.example.com
WS_PATH=/tunnel
ADDRESSES=104.16.1.1:443#入口一,edge.example.com:8443#备用
SOCKS5=socks5://user:password@proxy.example.com:1080
```

上面的 IP 和域名只是格式示例，**没有验证它们能为你的 Worker 提供连接**。`ADDRESSES` 是客户端连接 Worker 的**入口**；`SOCKS5` 是 Worker 连接目标网站的**出口**。它们位于连接的两端，不能互换。

## 所有环境变量：设置与不设置的影响

变量名区分大小写。在 Worker 的生产环境中配置；`UUID`、`SUB_TOKEN`、`ADMIN`、带认证的 `SOCKS5` 建议使用 Secret。修改 `UUID`、`SUB_TOKEN`、`HOST`、`WS_PATH` 或入口列表后，需要更新客户端订阅；现有客户端不会自动知道新值。

| 变量 | 格式与作用 | 不设置时 | 设置错误或不可用时 |
| --- | --- | --- | --- |
| **`UUID`** | **必填**。规范的 `8-4-4-4-12` 十六进制 UUID；用于 VLESS 握手验证，不要求特定 UUID 版本 | `/sub`、`/admin/api`、WebSocket 请求因配置不完整返回 **503**；`/health` 和 `/admin` 页面仍可打开 | 格式不对返回 **503**；客户端 UUID 与 Worker 不同则握手失败 |
| `SUB_TOKEN` | 16–256 个字符，不含换行；用于 `/sub` 的 URL `token` 或 Bearer 认证 | 等于 `UUID`，会把 UUID 放进订阅 URL | 长度或换行不合法时，相关请求返回 **503**；令牌不匹配时 `/sub` 返回 **401** |
| `ADMIN` | `/admin` 调用管理 API 的密码 | 等于有效的 `SUB_TOKEN`，如果 `SUB_TOKEN` 也没设则等于 UUID | 设错的密码只影响管理 API 登录，返回 **401**；空值按未设置处理，不改变订阅或 VLESS UUID |
| `HOST` | 域名，不带 `https://`、端口或路径；用于订阅节点的 TLS SNI 与 WebSocket Host | 使用**当前订阅请求的域名** | 格式错误时相关请求返回 **503**；格式正确但域名没有接入该 Worker、证书不匹配或路由错误时，订阅可以生成但客户端可能连接失败 |
| `WS_PATH` | WebSocket 路径；以 `/` 开头，仅字母、数字、`/`、`_`、`-`，最长 200 字符；不能是 `/`、`/sub`、`/health` | `/tunnel` | 格式不合法时返回 **503**；客户端路径与 Worker 不同，WebSocket 请求通常得到 **404** |
| `SOCKS5` | Worker 的**TCP 出口**；`socks5://[用户名:密码@]主机[:端口]`，也接受省略 `socks5://`；默认端口 1080 | 不经过 SOCKS5；若有 `PROXYIP` 则走中继，否则直接连接目标 | 格式不合法时返回 **503**；代理可解析但不可达、认证失败或不允许目标时，订阅仍可能正常，实际 TCP 会话失败，**不会自动直连** |
| `PROXYIP` | 原始 TCP 中继出口，`主机[:端口]`；没有显式端口则沿用客户端目标端口 | 不使用中继；若有 `SOCKS5` 则走 SOCKS5，否则直连 | 格式不合法时返回 **503**；中继不可达或不会转发原始流量时，订阅仍可能正常，TCP 会话失败；同时设置 `SOCKS5` 时它被 SOCKS5 覆盖 |
| `ADDRESSES` | 优选**入口**，IP/域名 `[:端口][#备注]`，逗号或换行分隔，1–64 个；默认端口 443 | 使用 `HOST`（若 `HOST` 也未设，则使用当前订阅请求域名）作为唯一入口 | 语法错误、超过 64 个或备注无效时相关请求返回 **503**；语法正确但入口不可用时，订阅可生成，客户端连接失败；KV 中已有保存列表时仍需保证此变量格式合法 |
| `DOH_URL` | HTTPS DNS-over-HTTPS 地址，不含账号、密码、片段；仅用于 VLESS UDP/53 | `https://cloudflare-dns.com/dns-query` | URL 不合法时相关请求返回 **503**；URL 合法但服务不可用时，TCP 不受影响，DNS 查询失败 |
| `TIMEOUT_MS` | 整数，1000–30000 毫秒；用于握手、连接、写入和 DNS 超时 | `10000`（10 秒） | 范围外或非整数时相关请求返回 **503**；过短可能令慢速连接超时 |

**配置错误的共同表现：**这些变量会在 `/sub`、`/admin/api` 和 WebSocket 请求前统一校验。即使暂时不用某个功能，该功能的变量若写成非法格式，也可能让订阅整体返回 503。`/health`、`/` 和 `/admin` 静态页面在校验前返回，因此它们仍可能显示正常。语法正确但网络服务不可达的 `SOCKS5`、`PROXYIP`、`DOH_URL` 或优选入口，则必须通过实际连接发现。

### SOCKS5 与 PROXYIP 具体写法

```text
SOCKS5=socks5://proxy.example.com:1080
SOCKS5=socks5://user:password@proxy.example.com:1080
SOCKS5=socks5://user:password@[2001:db8::1]:1080
PROXYIP=relay.example.com
PROXYIP=relay.example.com:443
```

SOCKS5 用户名、密码必须同时存在或同时省略；各为 1–255 个 UTF-8 字节。账号密码里的 `@`、`:`、`/` 等字符要按 URL 编码，例如 `@` 写作 `%40`。配置 SOCKS5 后，**全部 TCP** 都从 SOCKS5 出口走，没有旧版 `GO2SOCKS5` 域名名单。出口选择顺序是 **SOCKS5 → PROXYIP → 直连**；不是“先尝试直连，失败再自动重试 PROXYIP”。

`PROXYIP` 只能指向会接收并转发这条原始 TCP 流的中继，不是普通 HTTP 或 SOCKS 代理。`PROXYIP=relay.example.com` 使用原始目标端口；`PROXYIP=relay.example.com:443` 则固定连接中继的 443 端口。DNS-over-HTTPS 请求独立于这两个 TCP 出口。

## `SETTINGS` KV 命名空间：是否绑定会怎样

这里有**两个不同的名字**：Cloudflare 中 KV **命名空间自身的名称**（可以任意，例如 `my-vless-settings`），以及绑定到 Worker 时填写的**变量名称**（必须精确写成 **`SETTINGS`**，大写、无空格）。代码只访问 `env.SETTINGS`；绑定成旧版的 `KV`、`KQ` 或其他名称，相当于本版**没有绑定 KV**。可以选用已有命名空间，但需留意它包含的数据和访问权限。

| 状态 | 订阅 `/sub` | `/admin` 登录后 | 保存/恢复列表 |
| --- | --- | --- | --- |
| **没有 `SETTINGS` 绑定** | 正常使用 `ADDRESSES`；未设置时使用 `HOST` 或请求域名 | 能登录、查看当前列表和订阅地址；显示未连接存储 | 页面按钮禁用；直接调用保存/恢复 API 返回 **409** |
| **绑定正确，尚未保存列表** | 仍使用 `ADDRESSES`，再回退到 `HOST`/请求域名 | 显示当前环境变量列表；可编辑 | 保存后写入 KV |
| **绑定正确，已有保存列表** | **保存的列表优先于 `ADDRESSES`**，订阅以该列表生成 | 显示已保存列表 | “恢复环境变量列表”删除保存值，重新使用 `ADDRESSES` 或默认入口 |
| **KV 读取失败或保存值格式无效** | 订阅通常返回 **503** | 读取/保存列表可能返回 **503** | 检查绑定、KV 内容与 Worker 日志 |

后台只在 KV 中使用一个键：`preferred-addresses-v1`，保存的是优选入口文本；**UUID、订阅令牌、管理密码、SOCKS5 等变量不保存在这个 KV 中**。为已有命名空间增加 `SETTINGS` 绑定后，也不会自动迁移旧版后台的数据。即使 KV 中有有效的保存列表，基础配置仍会先校验 `ADDRESSES`；不要把环境变量留成非法格式。

绑定步骤：在当前 Worker 的**生产环境**中进入设置的 Bindings / 绑定，选择 KV 命名空间，选择或创建命名空间，并把绑定变量名称填为 `SETTINGS`。保存后确认生产部署使用该绑定，再打开 `/admin` 登录，检查页面是否显示可保存。预览环境的绑定和生产环境分别核对。KV 在不同地区可能有短暂同步延迟，保存后等待片刻并让客户端更新订阅。

## 自定义优选入口与订阅

`ADDRESSES` 以及管理页的列表使用相同格式，可以**每行一项**或用逗号分隔：

```text
104.16.1.1:443#入口一
edge.example.com:8443#备用入口
[2606:4700::1]:443#IPv6入口
```

每个入口包含服务器地址、可选端口和可选 `#备注`。不写端口默认为 443；不写备注时生成 `VLESS 1` 等默认名称；备注最长 100 字符。列表最多 64 个入口；管理页提交体最多 16 KiB。地址需要能连接到**服务你的 Worker 域名的入口**。订阅节点的 `server`/`port` 来自入口列表，但 TLS SNI、WebSocket Host 和路径分别来自 `HOST`、`WS_PATH`；因此把 `server` 改为优选 IP 不会自动把 SNI 改为 IP。

在浏览器打开 `https://你的Worker域名/admin`，以 `ADMIN` 登录。没有设置 `ADMIN` 时，使用 `SUB_TOKEN`；两者都没设置时，使用 UUID。登录后可复制以下订阅地址：

```text
https://你的Worker域名/sub?token=你的SUB_TOKEN
https://你的Worker域名/sub?token=你的SUB_TOKEN&format=raw
https://你的Worker域名/sub?token=你的SUB_TOKEN&format=clash
```

| 格式 | 返回内容 | 适用情况 |
| --- | --- | --- |
| 不指定或 `format=base64` | Base64 编码的 VLESS URI 列表 | 支持 Base64 VLESS 订阅的客户端 |
| `format=raw` | 明文 `vless://` 链接，每行一个 | 手动检查节点参数或导入明文链接 |
| `format=clash` | Clash/Mihomo 配置，内容使用 JSON 语法（也是有效的 YAML） | 支持该配置格式的客户端 |

`/sub` 也接受 `Authorization: Bearer <SUB_TOKEN>`。管理 API 使用 `ADMIN`，两套凭据可以不同。`/admin` 页面本身公开可访问，但 API 需要密码；前端仅在当前页面内存中保存管理密码，不写入 localStorage 或 Cookie。管理页生成的订阅 URL 含有令牌，复制和分享时请按密码对待。`format` 填其他值会返回 **400**。

## 验证与排障

按顺序检查**生产域名**，不要只看编辑器右侧预览：

1. 打开 `/health`，应得到 `VLESS Worker is running`。若此处出现 1101，先确认生产 Active 版本是否是刚部署的脚本，并查看 Worker 的生产日志。
2. 打开 `/sub?token=你的令牌&format=raw`，应看到 `vless://` 链接。此步能确认代码加载、变量格式和订阅鉴权；它不测试 TCP 出口或入口可达性。
3. 打开 `/admin` 并登录。需要在线保存时，确认页面显示已连接存储，保存一条入口后重新访问订阅并检查节点 `server` 是否变化。
4. 把订阅导入客户端，检查 `UUID`、TLS、WebSocket、SNI、Host、路径是否与订阅一致，再实际访问目标网站。只有这一步能验证 TCP 出口。

| 表现 | 优先检查 |
| --- | --- |
| `/health` 正常，但 `/sub` 返回 **503** | 缺少/非法 `UUID`，或任意变量格式不合法；若已绑定 KV，再检查保存列表和 KV 读取。查看生产 Worker 日志中的 `Worker configuration error` 或 `Subscription configuration failed`。 |
| `/sub` 返回 **401** | `SUB_TOKEN` 的实际值；没设置时应使用 UUID。`ADMIN` 不是订阅令牌，除非两者恰好相同。 |
| `/admin` 可打开但登录返回 **401** | `ADMIN` 的实际值；没设置时按 `SUB_TOKEN`、UUID 依次回退。 |
| `/admin` 能登录但不能保存 | 检查 KV 的**绑定变量名称**是否为 `SETTINGS`，以及绑定是否存在于生产环境；没有绑定时保存 API 返回 409。 |
| `/sub` 正常、客户端连不上 | 核对生产域名路由、入口地址、`HOST`/TLS 证书、`WS_PATH` 和 UUID，再检查 SOCKS5/PROXYIP 的可达性、认证及出口限制。 |
| 预览正常，`workers.dev` 生产访问异常 | 确认点击 Deploy 且新版本 Active；对照预览/生产环境的变量、KV 绑定和代码版本，查生产日志与 Ray ID。 |
| `workers.dev` 正常，自定义域名返回 **522** | 检查自定义域名是否绑定到这个 Worker、DNS/路由及域名状态；这种现象不能仅凭订阅代码判断。 |
| 连最小 Worker 脚本在生产也持续 **1101** | 优先定位生产部署/平台侧异常和日志；替换本项目代码不保证能修复。 |

## 本地构建、测试与 Wrangler

部署网页复制版**不需要安装 npm 依赖**。维护源码时需要现代 Node.js；开发验证使用 Node 24：

```sh
cd vless-worker
npm ci
npm test
npm run build
npm run test:runtime
```

`npm run build` 会同时更新根目录的无导入 `源码.js` 与本目录的 `worker.js`。修改功能应先改 `src/` 再构建；直接改生成文件会在下次构建时被覆盖。运行时测试使用 Miniflare/workerd，覆盖订阅鉴权、KV 保存与恢复、WebSocket UUID 验证、真实 TCP、SOCKS5 认证、分片握手及双向回传；它不能替代你的 Cloudflare 生产环境、真实代理和自定义域名测试。

本目录的 [`wrangler.toml`](./wrangler.toml) 默认以 `worker.js` 为入口，可在此目录运行 `npx wrangler deploy` 部署官方 TCP API 版本。若用 Wrangler 部署根目录无导入文件，先把 `main` 改为 `../源码.js`。使用 Wrangler 时也要在目标 Worker 的生产环境中设置同名 Secret/变量，并按需配置 `SETTINGS` KV 绑定。

## 参考与许可

协议能力参考 [zizifn/edgetunnel 的 worker-vless.js](https://github.com/zizifn/edgetunnel/blob/main/src/worker-vless.js)。本实现独立编写，采用不同的模块组织、增量解析和连接生命周期，没有复制原管理面板或混淆源码。TCP API 参考 [Cloudflare TCP sockets 文档](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)；Clash 字段参考 [Mihomo VLESS 文档](https://wiki.metacubex.one/en/config/proxies/vless/)。本目录代码遵循仓库根目录的 GPL-2.0 LICENSE。
