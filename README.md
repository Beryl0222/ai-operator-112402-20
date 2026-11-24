# 离线贴纸特征的可逆整数耦合流

项目资料使用可独立读写的 JSON。Node.js 22.23.4 下运行 `npm ci --offline` 准备环境，然后运行 `npm run inspect` 检查合成数据字段，运行 `npm test` 校验样本引用及格式。

## 输入契约

通道按偶/奇分组，两级系数以稀疏 [to,from,num,den] 给出，分别指定更新前一组时使用的另一组通道。每个目标方向把有理贡献求和，然后向 -∞ 取整。第一次更新偶组加修正，第二次更新奇组加修正。mod 以 2^bits 取非负余数，strict 使用有符号 bits 并拒绝中间不能表达的值。反解须逐值恢复已经合法交付的源坐标。laneType 对 input、padding 和 unknown 区分；静态 padding 不出现在解码输出，空间预算计运行时未交付值及内部工作区。

## 资料读取

样本位于 `inputs/session.json`，其中 `events` 是按到达顺序记下的操作，编号从零开始。tile 提供同 ID 的输入片，encode 提交片 ID 与量化包，read 按修订和所需通道取结果，history 按修订查询已交付表达。
