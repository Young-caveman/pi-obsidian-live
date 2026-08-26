# Agent 记忆系统调研报告与改造方向

> 日期：2026-08-26
> 范围：主流 AI 编码 Agent（Codex / Claude Code / opencode / Cursor 等）与学术系统（MemGPT / Mem0 / Generative Agents / MemoryBank）的记忆实现细节，以及 pi-obsidian-live 记忆模块（Learning Spaces）的对照诊断与改造路线。
> 方法：官方文档 + GitHub 源码直接读取（Codex 记忆管线提示词全文通过 sparse-checkout 取出）+ 论文原文 + 基准评测资料。

---

## 1. 核心结论速览

1. **没有任何主流系统用"置信度数字"做记忆门控**。置信度（confidence）是本项目独创且用法独特（写入门控）的设计。主流的替代机制是：定性证据强度分层（Codex）、操作分类器（Mem0）、类型分桶 + 语义判断（Claude Code）、检索加权 importance（Generative Agents）。
2. **写入端真正的质量阀门是"最小信号门"**（Minimal Signal Gate）：提取前先问"未来 agent 会不会因为这条记忆而表现更好？"不通过就输出空（no-op），而不是打低分。
3. **主流触发是"会话级/批处理"**（Codex 启动时批量跑），我们是"回合级"（每次 agent_settled 都入队）——这是内存膨胀（一次对话几十条候选）的第一根因。
4. **防膨胀三件套：整合（consolidation）、去重、遗忘**，主流系统均有，我们全缺。
5. **评估缺位**：LongMemEval / LoCoMo 基准揭示的关键教训——记忆不带时间戳会导致时间推理能力崩盘（OpenAI 记忆时间推理 <15%）。
6. 主流生态**无人做人工 review**（Claude Code 的 `/memory` 只是事后审计）。

---

## 2. 各家实现细节

### 2.1 OpenAI Codex（最完整的设计，源码级）

来源：`openai/codex` 仓库 `codex-rs/memories/`（write 提示词模板）+ `codex-rs/core/src/memories/` 编排。

**运行时机**：根会话**启动时**异步跑（不是会话中逐回合），仅当：会话非临时、记忆功能开启、非子 agent 会话。批处理，带租约认领、并发上限、失败退避重试、每次启动有工作量上限。

**Phase 1：Rollout 提取（每线程）**
- 只处理 eligible rollouts：来源允许、在年龄窗口内、**idle 足够久**（避免总结活跃会话）、未被认领、有数量上限。
- 每个 rollout 调模型输出结构化 JSON：`raw_memory` + `rollout_summary` + `rollout_slug`。
- 输出前过 **NO-OP / MINIMUM SIGNAL GATE**（原文）：

  > "Will a future agent plausibly act better because of what I write here?"
  > 不通过（一次性查询、通用状态更新、临时事实、常识、无新工件、无偏好信号）则返回全空字段。
  > 高信号优先级：① 稳定用户操作偏好（反复要求/纠正/打断）② 高杠杆过程知识（失败盾牌、精确路径/命令、难发现事实）③ 可靠任务地图 ④ 环境与工作流事实。明确非目标：通用建议、秘密、大段原文、探索性讨论、助手提案。
  > 证据权重方向（原文明确）：**用户消息 > 工具输出 > 助手消息**。
- **Task outcome triage**：每条任务先分类 success / partial / fail / uncertain，启发式：显式用户反馈 > 环境/测试验证 > 推断；最后一条任务默认保守（无反馈则 uncertain）。
- `raw_memory` 带 frontmatter：`description / task / task_group / task_outcome / cwd / keywords`，正文分 `Preference signals:`（证据→含义，保留用户原话）、`Reusable knowledge:`（只放验证过的事实）、`Failures and how to do differently:`（症状→原因→转向）、`References:`（可直接复用的 verbatim 字符串）。**保留原文措辞**（word-preserving）因为未来靠 grep。

**Phase 2：全局整合（consolidation）**
- 三层渐进披露架构：
  - `memory_summary.md`：**常驻注入**系统提示词；首行必须是 `v1`；用户画像 ≤350 词；极力压缩（"optimize for high signal per token"）；含 User Profile / User preferences / General Tips / What's in Memory（按 cwd→日期 分层的路由索引）。
  - `MEMORY.md`：按 `# Task Group`（cwd/工作流）聚簇的 handbook；每块必带 `scope:` 和 `applies_to:`（防止跨目录误用）；块内 Task 列表 → `## User preferences` → `## Reusable knowledge` → `## Failures and how to do differently`；`## Task <n>` 必带 `rollout_summary_files` 与 **`keywords`**（检索把手）；**不设固定数量**（"Do not target fixed counts"），但聚类归并控制规模。
  - `rollout_summaries/`：引用层，按需读取；原始 rollout 不可变只做证据。
  - `skills/`：重复流程固化为可执行技能（SKILL.md + scripts/），"procedure repeats (more than once) → 固化"。
- **增量更新**：记忆工作区是 git 仓库，用注入的 git diff 定位新增/修改/删除；**遗忘 = 删除只由已删输入支持的记忆**；混合块只删陈旧引用、保留仍被支持的证据。
- **冲突处理**：`updated_at` 新鲜度优先；验证不明确时**显式保留不确定性**；"新的验证过的证据通常赢"。
- **防漂移规则**：探索性讨论、一次性印象、助手提案不得升级为持久记忆；"underindex on assistant messages"。

**读路径（memories/read）**：memory_summary 注入 + MEMORY.md 按需 grep + citation 解析 + 用量遥测。

### 2.2 Claude Code（最简主义，文件即记忆）

来源：官方 docs pages（memory / code.claude.com/docs/en/memory）。

- 两套系统：`CLAUDE.md`（用户/项目/组织写的指令，向上目录树加载）+ **Auto Memory**（Claude 自己写的笔记）。
- Auto memory 笔记四类（frontmatter `type` 字段）：`user`（角色/偏好）、`feedback`（纠正）、`project`（进行中决策）、`reference`（外部信息源）。**跳过能从代码库推导的内容**（架构、路径、调试修复）、跳过 CLAUDE.md 已写的。
- 存储：`~/.claude/projects/<repo>/memory/`，每仓库一个；`MEMORY.md` 是指索 + 每主题一个 topic 文件。
- **渐进披露**：`MEMORY.md` 前 200 行或 25KB 常驻载入（先到先得）；Topic 文件不注入，模型用文件工具**按需读取**；索引超限会强制重写（"keep one line per entry, move detail into topic files"）。
- 前 200 行/25KB 截断 = 从注入源头限制开销，召回靠模型自己决定读哪个 topic 文件。
- 无需人工 review（`/memory` 命令只是浏览/编辑/开关）。

### 2.3 Mem0（生产级记忆层，论文 arXiv:2504.19413）

- 两阶段管线（图 2）：
  - **Extraction**：输入 = 新消息对 (mₜ₋₁, mₜ) + 会话摘要 S（周期刷新提供全局上下文）+ 最近 m=10 条消息（局部时间上下文）→ LLM 提取候选事实集合 Ω。
  - **Update**（关键创新）：候选事实与库中相似记忆（s=10 条向量检索）比较，**LLM 直接分类操作**：
    ```
    ClassifyOperation(f, M, M'):
      if ¬SemanticallySimilar(f, M)  → ADD
      else if Contradicts(f, M)      → DELETE     （冲突替换）
      else if Augments(f, M)         → UPDATE     （增强改写，不新增）
      else                           → NOOP       （无变化不写）
    ```
  - 即：**用"该不该写/改/删"的分类决策取代评分门槛**；UPDATE 是防重复膨胀的关键。
- Mem0ᵍ（图版）：实体三元组 (vₛ, r, v_d)；冲突检测 + LLM update resolver；**过时关系标记 invalid 而非物理删除**（支持时间推理）。
- 评测（LoCoMo，600 会话）：Mem0 全面领先；**OpenAI 记忆因大部分缺时间戳，时间推理得分 <15%**（p95 延迟还高 91% 于 Mem0）。
- 参考基线：Zep（时间知识图谱）、LangMem、A-Mem、RAG 变体、full-context。

### 2.4 Stanford Generative Agents（学术源头，"置信度"最接近物）

来源：arXiv:2304.03442（Smallville）。

- **Memory stream**：时间戳自然语言观察记录库。
- 检索评分（记忆检索不是只靠相似度）：
  ```
  score = α_recency·recency + α_importance·importance + α_relevance·relevance   （α 均 =1）
  recency:   0.995 指数衰减（按游戏小时，自上次检索起）→ min-max 归一化
  importance: 创建时 LLM 打分 1~10（"poignancy"）→ min-max 归一化
  relevance:  查询与记忆嵌入的余弦相似度
  ```
- **importance 只用于检索加权，不用于写入门控**；且只占 1/3 权重。
- **反思（reflection）**：当最近事件 importance 累计 > 150 时触发；用最近 100 条记忆提炼 3 个高维问题 → 作为查询召回 → LLM 提炼洞察并引用证据记录 → 反思写回 stream（提升抽象层级）。
- 对用户"全部进+召回筛"直觉的回应：最接近的是这个系统——软加权 + 反思提炼，而非阈值硬删。

### 2.5 其他

- **MemGPT / Letta**：OS 式虚拟上下文管理（RAM/磁盘 paging 类比），模型自己通过函数调用管理主上下文/外部上下文分层（arXiv:2310.08560）。无评分。
- **opencode**：本身无记忆；`AGENTS.md` 是每轮注入的项目规则（不属于"学到的记忆"）；第三方 agentmemory 插件在每次 LLM 调用前注入项目档案+会话摘要+历史观察。
- **MemoryBank**（arXiv:2305.10250）：艾宾浩斯遗忘曲线 → 记忆随时间衰减 + LLM 动态更新 + 性格画像合成。
- **pi 生态**：pi-memory（日志+长期记忆+qmd 语义搜索）、pi-hermes-memory（自动提取分类：failures/corrections/insights/conventions/tool quirks）、pi-memory-system（三层 Markdown）。
- **评测基准**：LongMemEval（ICLR 2025）516 题，五大能力——信息提取、多会话推理、知识更新、时间推理、abstention（该拒绝时拒绝）；LoCoMo（ACL 2024，超长多会话）。

---

## 3. 设计维度对照表

| 维度 | Codex | Claude Code | Mem0 | Generative Agents | **pi-obsidian-live（现状）** |
|---|---|---|---|---|---|
| 提取触发 | 启动时批量（eligible rollouts） | 事件驱动（值得才写） | 每消息对，增量 | 每观察（stream） | **每回合 agent_settled 入队** ⚠️ |
| 写入门控 | 最小信号门（空输出=no-op） | 语义判断+类型分桶 | ADD/DELETE/UPDATE/NOOP 分类器 | 全部写入（stream） | **confidence 阈值（自评分数，无信号门）** ⚠️ |
| 证据权重 | 用户消息＞工具输出＞助手 | 跳过可推导内容 | 消息对语义 | 时间/重要性/相关性 | **无（原文指引弱）** ⚠️ |
| 存储结构 | 三层（summary/MEMORY/rollout）+skills | 索引+主题文件（渐进披露） | 向量库+图 | timestamped stream | **扁平 JSON 目录（inbox/memories/）** |
| 整合/去重 | Phase 2 consolidation（git diff 增量） | 主题归并+索引压缩 | UPDATE 改写 / invalid 标记 | 反思提炼（重要性阈值） | **无** ⚠️ |
| 遗忘 | 删除无证据支撑的记忆 | 索引超限重写/手动删 | DELETE / invalid | 衰减加权 | **无** ⚠️ |
| 召回 | summary 注入+MEMORY grep | 索引注入+topic on-demand | 向量 top-K | 三项加权 top-K | **BM25+语义 RRF top5** ✅（结构接近 Mem0/GA） |
| 注入时间戳 | 有（updated_at 为一等信号） | 有（modified 字段） | 有（时间锚定，评测关键） | 有（stream 天然时间戳） | **无（注入记录不含 createdAt）** ⚠️ |
| 人工 review | 无 | 无（/memory 仅审计） | 无 | 无 | **有（/memory accept，可选自动阈值）** |
| 评估 | 内部评测 | — | LoCoMo 横评 | 论文实验 | **无** |

✅ = 与主流一致或接近；⚠️ = 差距点。

---

## 4. 诊断：为什么一次对话产生几十条候选

根因链（按影响排序）：

1. **回合级触发无节流**：每次 agent_settled 都入队，一天 30 回合就 30 个 job；主流（Codex）是"会话结束够久后"批量提取一次。
2. **提取无最小信号门**：我们的提示词只有一句 "Do not keep transient narration..."；Codex 有专门的 no-op gate + 高信号优先级 + outcome triage，把"该不该提取"作为第一道闸。
3. **无整合/去重层**：同主题（如"埋点分类"）在每个回合被独立提取，多回合重复存储；Mem0 用 UPDATE/NOOP 把新知识改写进旧记忆，Codex 用 Phase 2 聚类归并。
4. **无会话内上下文**：提取时只看到当前回合文本，不知道之前已存了什么 → 无法判断"这条已存在/已矛盾/是增强"。
5. **置信度不可靠**：模型自评分数（无校准、无 logits、缺失默认 0.5），主流并不使用。

---

## 5. 改造方向（按优先级，全部可被现有架构支撑）

> 决策记录：2026-08-26，暂不实施，先存档。用户提出"全部进入 + 召回时按置信度筛选"的主张，经调研被判定为**逆主流设计**（主流 = 写入端信号门 + 整合去重 + 检索相关性排序）；最接近用户直觉的是 Generative Agents 的检索加权（importance 仅 1/3 权重），但不应作为唯一机制。

| # | 改动 | 成本 | 依据 | 预期效果 |
|---|---|---|---|---|
| 1 | **提取提示词升级**：最小信号门（"未来 agent 会因此表现更好吗"）+ 高信号优先级（用户偏好＞失败盾牌＞过程知识）+ 用户消息权重 + task outcome triage | 低（改 `buildExtractionPrompt`） | Codex stage_one_system | 直接减少低质候选数量 |
| 2 | **提取带已有记忆上下文**：提取时注入该 Space 最相似的已接受记忆（现有 embedding 后端已就绪），要求模型输出 `ADD / UPDATE / NOOP` 判定 | 低（job 流程内） | Mem0 update 阶段 | 跨回合去重、改写增强而非重复新增 |
| 3 | **触发收紧**：同一 leaf 上次提取内容未变化则不重复入队；或合并多次 agent_settled 的增量 | 低 | Codex eligible rules | 从源头遏制 job 堆积 |
| 4 | **置信度改为检索软加权**（RRF 分 × confidence 系数），撤写入门控默认 | 中 | Generative Agents | 召回排序更稳，副作用小 |
| 5 | **注入带时间戳 + 记忆 updated_at 溯源** | 低 | LongMemEval 教训（OpenAI <15%） | 支持知识更新与时间推理 |
| 6 | **层级化存储**：index（常驻路由层）+ 详情文件按需读 + keywords 字段 | 高（架构级） | Claude Code / Codex 渐进披露 | 注入开销可控、可扩展 |
| 7 | （可选）**遗忘/淘汰**：按时间与使用频率淘汰，或删除无证据支撑的旧条目 | 中 | Codex git-diff 遗忘 / MemoryBank 衰减 | 长期不膨胀 |
| 8 | （可选）**评估**：以 LongMemEval 五能力为纲做自测（信息提取/多会话推理/知识更新/时间推理/abstention） | 中 | ICLR 2025 | 量化改进效果 |

**推荐实施顺序**：1 → 2 → 3（一个迭代内完成，直击"几十条"问题）→ 5 → 4 → 6/7/8（远期）。
**不推荐**：将 confidence 设为唯一门控；默认开启全自动接受（autoAcceptMinConfidence=0）。

---

## 6. 关键原文摘录（供实现时引用）

**Codex 最小信号门**（stage_one_system.md）：
> "Before returning output, ask: 'Will a future agent plausibly act better because of what I write here?' If NO ... then return all-empty fields exactly: `{"rollout_summary":"","rollout_slug":"","raw_memory":""}`"

**Codex 高信号定义**（stage_one_system.md）：
> "High-signal memory is not just 'anything useful.' It is information that should change the next agent's default behavior in a durable way."

**Codex 证据权重**（stage_one_system.md）：
> "Read much more into user messages than assistant messages. User requests, corrections, interruptions, redo instructions, and repeated narrowing are the primary evidence."

**Mem0 操作分类**（论文 Algorithm）：
> `ClassifyOperation`: ¬Similar → ADD；Contradicts → DELETE；Augments → UPDATE；否则 NOOP。

**Claude Code 跳过规则**（官方文档）：
> "Claude skips anything it can derive from the codebase, such as architecture, file paths, or debugging fixes. It also skips anything your CLAUDE.md files already say."

**Generative Agents 检索公式**（论文）：
> `score = α_recency · recency + α_importance · importance + α_relevance · relevance`，recency 0.995 指数衰减；importance 由 LLM 打 1~10；反思在 importance 累计 >150 时触发。

**LongMemEval 五能力**：
> information extraction / multi-session reasoning / knowledge updates / temporal reasoning / abstention（500+ 题，ICLR 2025）。

---

## 7. 调研来源

- OpenAI Codex 源码（sparse-checkout）：`codex-rs/memories/write/templates/memories/{stage_one_system,stage_one_input,consolidation}.md`、`codex-rs/memories/README.md`
- Claude Code 官方文档：code.claude.com/docs/en/memory
- Mem0 论文：arXiv:2504.19413（含 ClassifyOperation 伪代码与 LoCoMo 横评）
- Generative Agents：arXiv:2304.03442；实现细节取自 arXiv HTML 版
- MemGPT：arXiv:2310.08560
- MemoryBank：arXiv:2305.10250
- LongMemEval：arXiv:2410.10813（ICLR 2025）；LoCoMo：ACL 2024
- opencode 文档与社区分析（dev.to "OpenCode Memory Internals"）
- pi 生态：pi-memory（jayzeng）、pi-hermes-memory（chandra447）、pi-memory-system（Hdaisen）