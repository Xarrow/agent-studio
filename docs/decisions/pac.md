# 评估：PAC / WPAD 要不要做

## 结论
本版不做。理由：

1. WPAD 依赖 DNS/NetBIOS 自动发现，在容器与远程服务器上几乎不可用；
2. PAC 需要执行 JS（`FindProxyForURL`），引入运行时依赖与"脚本来源可信"问题；
3. 目标用户（公司网络）绝大多数只配 HTTP 代理 + 少量 NO_PROXY，手动/环境变量已覆盖；
4. 真要做，正确形态是"系统代理"模式读取 OS 设置（macOS scutil / Windows WinHTTP / Linux 无统一），
   这属于平台适配工作，与技能安装不是同一优先级。

## 现状
`proxy_mode=system` 在 Linux 上退化为环境变量，并在诊断里标注"system 代理在 Linux 无统一接口"。
