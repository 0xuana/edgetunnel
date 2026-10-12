# Xuana VLESS Worker

独立重写的 Cloudflare Workers 实现：VLESS over WebSocket、TCP、SOCKS5 出口、自定义优选订阅，以及一个简洁的订阅管理页。

部署文件是本目录的 **`worker.js`**。它已经包含全部实现及管理页，只有 `cloudflare:sockets` 这个 Workers 内置导入，不需要上传其他源码，也不需要在线混淆。

文件开头的 `import { connect } from "cloudflare:sockets"` 必须保留。它不会从 GitHub、npm 或其他 JavaScript 文件下载代码，CF 运行时会直接提供此 API。TCP/SOCKS5 所需的原生套接字无法用普通 JavaScript 内嵌代替；删除这行会破坏代理功能。所有 `src/` 模块已经打包到这个文件，注释中的源码路径只是构建标记。

## 网页部署

1. 创建 Workers 项目，把 `worker.js` 的全部内容复制到代码编辑器，替换默认脚本。
2. 设置必需的秘密变量 `UUID`。请自行生成，不要使用测试代码中的 UUID。Node.js 可执行 `node -e 'console.log(crypto.randomUUID())'`。
3. 设置 `SUB_TOKEN` 为随机订阅令牌，建议至少 32 个随机字符；省略时使用 UUID。设置 `ADMIN` 为独立管理密码；省略时使用 SUB_TOKEN。
4. 如果需要 SOCKS5 出口，设置秘密变量 `SOCKS5`，例如 `socks5://user:password@proxy.example.com:1080`。
5. 如需后台保存自定义优选列表，创建或选择一个 KV 命名空间，绑定名称填写 **`SETTINGS`**。存储空间本身的名称可以任意，代码读取的是绑定名称。不使用后台保存时无需 KV。
6. 点击 Deploy，在项目的 Deployments 中确认当前版本为 Active。
7. 访问 `https://你的Worker域名/health` 应返回 `VLESS Worker is running`。这是运行检查；它不检查 UUID、KV 或出口代理是否可用。
8. 访问 `/admin`，输入 ADMIN 管理密码，编辑入口列表并保存。

自定义域名需要在 Worker 的 Domains / Routes 中正式添加。优选订阅中的 HOST 必须对应实际服务这个 Worker 的域名。仅添加 DNS 记录不等于完成 Worker 域名绑定。

## 环境变量

| 名称 | 必需 | 用途 / 默认值 |
| --- | --- | --- |
| `UUID` | 是 | VLESS 客户端身份，规范 UUID；不从 ADMIN 派生 |
| `SUB_TOKEN` | 否 | 订阅访问令牌，16–256 字符；默认 UUID |
| `ADMIN` | 否 | 管理页密码；默认 SUB_TOKEN |
| `HOST` | 否 | TLS SNI 与 WebSocket Host；默认请求域名，不包含协议、端口或路径 |
| `WS_PATH` | 否 | WebSocket 路径，默认 `/tunnel` |
| `SOCKS5` | 否 | SOCKS5 出口，支持无认证、用户名密码及 IPv6 |
| `PROXYIP` | 否 | 显式 TCP 中继出口，格式 `域名或IP[:端口]`；不是优选入口 |
| `ADDRESSES` | 否 | 自定义优选入口列表；默认 HOST；后台保存的列表覆盖此值 |
| `DOH_URL` | 否 | UDP DNS 使用的 HTTPS 解析器，默认 `https://cloudflare-dns.com/dns-query` |
| `TIMEOUT_MS` | 否 | 握手、连接、写入与 DNS 超时，1000–30000 毫秒；默认 10000 |

`UUID`、`SUB_TOKEN`、`ADMIN`、带认证的 `SOCKS5` 应设置为秘密变量。后台只编辑优选入口，出口变量在 Workers 设置中配置。

## 自定义优选订阅

在 `/admin` 输入列表；每行一个入口，支持 IP、域名、端口和备注。未指定端口时为 443，最多 64 个入口、16KB。

```text
104.16.1.1:443#入口一
edge.example.com:8443#备用入口
[2606:4700::1]:443#IPv6入口
```

这些地址是格式示例，没有经过可用性或速度测试。它们必须能连接到服务该 Worker 域名的 Cloudflare 入口。

也可以在 `ADDRESSES` 变量中填写换行或逗号分隔的列表。后台保存需要 SETTINGS KV；没有 KV 时，管理页能显示环境变量配置与订阅地址，但保存按钮禁用。

在后台点击“恢复环境变量列表”会删除后台保存值，重新使用 ADDRESSES 或 HOST。KV 在不同地区的更新存在短暂延迟；保存后稍等并刷新客户端订阅。

生成的链接始终保留自己的 TLS SNI、WebSocket Host 和路径；修改入口 IP 不会把这些字段替换为 IP。

## 订阅接口

```text
https://你的Worker域名/sub?token=你的SUB_TOKEN
https://你的Worker域名/sub?token=你的SUB_TOKEN&format=raw
https://你的Worker域名/sub?token=你的SUB_TOKEN&format=clash
```

默认是 Base64 编码的 VLESS URI 列表，适用于支持此订阅格式的客户端。`raw` 输出明文 VLESS 链接。`clash` 输出完整 Clash / Mihomo 配置；文件内容使用 JSON 语法，这是合法的 YAML，避免备注造成 YAML 注入。

订阅接口也支持 `Authorization: Bearer <SUB_TOKEN>`。管理页提供三种订阅地址，密码只保存在当前页面内存，不写入 localStorage 或 Cookie。

## SOCKS5 与 PROXYIP 出口

出口选择顺序：**SOCKS5 → PROXYIP → 直接连接目标**。

设置 SOCKS5 后，全部 TCP 连接经 SOCKS5 建立，不按域名白名单筛选。代理不可用时关闭连接并记录错误，不会悄悄直连。

```text
SOCKS5=socks5://proxy.example.com:1080
SOCKS5=socks5://user:password@proxy.example.com:1080
SOCKS5=socks5://user:password@[2001:db8::1]:1080
```

账号密码中的 `@`、`:`、`/` 等字符应分别 URL 编码，例如 `@` 写为 `%40`。认证字段各自支持 1–255 个 UTF-8 字节。

PROXYIP 只适用于能够接收原始目标流量的中继，不是普通 SOCKS/HTTP 代理。例如 `PROXYIP=relay.example.com` 保留客户端目标端口；`PROXYIP=relay.example.com:443` 固定使用 443。该模式直接使用指定中继，**不提供旧版本“直连失败后自动重放到中继”的逻辑**；一般目标转发优先使用 SOCKS5。

**UDP 只支持端口 53 的 DNS**，通过 DOH_URL 发送，独立于上述 TCP 出口。任意 UDP、QUIC、MUX、Reality、Vision、gRPC、XHTTP、Trojan 和 Shadowsocks 不在此版本范围内。

## 本地维护与测试

需要现代 Node.js；开发验证使用 Node 24。部署不需要 npm 依赖，下面的依赖仅用于本地构建和测试。

```sh
cd vless-worker
npm ci
npm test
npm run build
npm run test:runtime
```

`src/` 是独立模块源码，`worker.js` 是生成的单文件。修改源码后运行 build，避免只改生成文件导致下次构建覆盖。

运行时测试使用 Miniflare/workerd，覆盖订阅鉴权、KV 保存及重置、WebSocket UUID 验证、真实 TCP 套接字、SOCKS5 认证、分片握手和双向回传。SOCKS5 测试服务器仅监听本机，不访问你的真实代理。

如用 Wrangler 部署，在本目录运行 `npx wrangler deploy`。配置入口已设置为 `worker.js`，请先设置变量/秘密变量，并按需添加 SETTINGS KV 绑定。

## 排查

- `/health` 正常、`/sub` 返回 503：检查 UUID、变量格式和 SETTINGS 中的列表；查看日志中的配置错误。
- 订阅返回 401：检查 SUB_TOKEN；管理页密码 ADMIN 与订阅令牌可以不同。
- 订阅正常但代理失败：检查 SOCKS5 可达性、认证和出口限制；通过实际客户端连接测试，订阅成功不代表出口正常。
- 连最小脚本也持续报 1101：单靠这份重写无法保证修复原项目的平台状态。保留证据并检查生产部署与平台日志。

## 参考与许可

协议能力参考用户指定的 [zizifn/edgetunnel worker-vless.js](https://github.com/zizifn/edgetunnel/blob/main/src/worker-vless.js)。本实现独立编写，采用不同的模块组织、增量解析和连接生命周期，没有复制原管理面板或混淆源码。

Workers TCP 接口参考 [Cloudflare TCP sockets 文档](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/)，Clash 字段参考 [Mihomo VLESS 文档](https://wiki.metacubex.one/en/config/proxies/vless/)。本目录代码遵循仓库根目录的 GPL-2.0 LICENSE。
