import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Readable, Writable } from 'node:stream';
import path from 'node:path';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const require = createRequire(path.join(root, 'apps/server/package.json'));
const acp = await import(pathToFileURL(require.resolve('@agentclientprotocol/sdk')).href);
const { Client } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/index.js')).href
);
const { StdioClientTransport } = await import(
  pathToFileURL(require.resolve('@modelcontextprotocol/sdk/client/stdio.js')).href
);
const worker = process.argv.includes('--worker');
let client;
const pause = () => new Promise((resolve) => setTimeout(resolve, 1800));
async function call(name, args) {
  const result = await client.callTool({ name, arguments: args });
  if (result.isError) throw Error(JSON.stringify(result));
  return JSON.parse(result.content.find((p) => p.type === 'text').text);
}
async function emit(ctx, text) {
  await ctx.client.notify(acp.methods.client.session.update, {
    sessionId: ctx.params.sessionId,
    update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text } },
  });
}
acp
  .agent({ name: worker ? 'hermes-poc-mock-worker' : 'hermes-poc-mock-leader' })
  .onRequest(acp.methods.agent.initialize, (ctx) => ({
    protocolVersion: ctx.params.protocolVersion,
    agentCapabilities: {},
    agentInfo: { name: 'Local deterministic mock — no model calls', version: '1.0.0' },
  }))
  .onRequest(acp.methods.agent.session.new, async (ctx) => {
    if (!worker) {
      const c = ctx.params.mcpServers[0];
      if (!c) throw Error('Missing control-plane bridge');
      client = new Client({ name: 'hermes-workbench-mock', version: '1.0.0' });
      await client.connect(
        new StdioClientTransport({
          command: c.command,
          args: c.args,
          env: Object.fromEntries(c.env.map((e) => [e.name, e.value])),
          stderr: 'inherit',
        }),
      );
    }
    return { sessionId: `mock-${worker ? 'worker' : 'leader'}` };
  })
  .onRequest(acp.methods.agent.session.prompt, async (ctx) => {
    const prompt = ctx.params.prompt.map((p) => p.text ?? '').join('');
    if (worker) {
      await emit(ctx, '正在检查收到的任务与交接信息。\n');
      await pause();
      const calculation = /19\s*[×x*]\s*17/.test(prompt);
      await emit(
        ctx,
        calculation ? '计算结果：19 × 17 = 323。\n' : '已收到目标并完成本地模拟检查。\n',
      );
      await pause();
      await emit(ctx, '这是确定性模拟 Agent 的验证输出；结果由协作引擎保存为产物。');
    } else if (
      prompt.startsWith('Continue with durable worker results.') ||
      prompt.startsWith('Resume the durable task.')
    ) {
      const marker = '\nPreviously delivered messages (recovery context, not new work):\n';
      const text = prompt.includes(marker)
        ? prompt.slice(prompt.indexOf(marker) + marker.length)
        : prompt.slice(prompt.indexOf('\n') + 1);
      const messages = JSON.parse(text);
      const refs = messages.flatMap((m) => m.artifactRefs ?? []);
      if (!refs.length) throw Error('No durable result to summarize');
      const results = [];
      for (const artifactId of refs) {
        const artifact = await call('control_get_artifact', { artifactId });
        results.push(artifact.content);
      }
      await pause();
      await emit(
        ctx,
        `## 协作完成\n\n${results.join('\n\n')}\n\n负责人已经读取持久化产物并汇总。你可以在右侧“结果”中下载文件。\n\n_本次为本地模拟验证，未调用 Codex 或 Antigravity。_`,
      );
    } else {
      const objective = prompt.split('\n\nExecution context')[0];
      await emit(ctx, '已接收目标，正在寻找协作者。');
      await pause();
      const candidates = await call('control_discover_agents', { exact: ['code.review'] });
      if (!candidates.length) throw Error('No mock worker available');
      const task = await call('control_create_task', { title: '协作者检查与执行', objective });
      await call('control_delegate_task', {
        taskId: task.id,
        agentId: candidates[0].agentId,
        role: { name: '协作者' },
      });
      await emit(ctx, '已委派任务，等待协作者的持久化结果。');
    }
    return { stopReason: 'end_turn' };
  })
  .connect(acp.ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin)));
