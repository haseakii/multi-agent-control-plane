import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const run = path.join(root, '.run/hermes-integration');
const buildArgs = process.argv.slice(2);
if (
  !(
    buildArgs.length === 0 ||
    (buildArgs.length === 1 && buildArgs[0] === '--typecheck') ||
    (buildArgs.length === 2 && buildArgs[0] === '--output' && buildArgs[1])
  )
)
  throw new Error(
    'Usage: node integrations/hermes-workbench/build.mjs [--typecheck | --output NEW_WEB_DIRECTORY]',
  );
const privateOutput = buildArgs[0] === '--output';
const webOutput = privateOutput ? path.resolve(buildArgs[1]) : path.join(run, 'web-dist');
if (privateOutput && fs.existsSync(webOutput))
  throw new Error(
    'Web output already exists; choose a new directory. No existing assets were changed.',
  );
const builtAt = new Date().toISOString();
const upstream = path.join(
  run,
  'source/Hermes-CN-Desktop-06e15d0e5d3c27f1fd37f09579f26f91c020036e',
);
const web = path.join(upstream, 'web');
// Several Radix packages omit LICENSE from their published files list. The same
// pinned monorepo's primitive package includes the root WorkOS MIT full text.
// Carry that text with a recorded source, without altering installed packages.
const radixRoot = path.join(
  upstream,
  'node_modules/.pnpm/@radix-ui+primitive@1.1.3/node_modules/@radix-ui/primitive',
);
const radixManifest = JSON.parse(fs.readFileSync(path.join(radixRoot, 'package.json'), 'utf8'));
if (
  radixManifest.name !== '@radix-ui/primitive' ||
  radixManifest.version !== '1.1.3' ||
  radixManifest.license !== 'MIT' ||
  radixManifest.repository?.url !== 'git+https://github.com/radix-ui/primitives.git'
)
  throw new Error('Pinned Radix monorepo license source changed.');
const radixLicense = {
  text: fs.readFileSync(path.join(radixRoot, 'LICENSE'), 'utf8'),
  license: 'MIT',
  source:
    '@radix-ui/primitive@1.1.3/LICENSE; https://github.com/radix-ui/primitives/blob/main/LICENSE',
};
const licenseDirectory = path.join(root, 'integrations/hermes-workbench/licenses');
const extraSources = JSON.parse(
  fs.readFileSync(path.join(licenseDirectory, 'sources.json'), 'utf8'),
);
const extraLicenses = {};
for (const [key, source] of Object.entries(extraSources)) {
  if (
    !/^[a-z0-9-]+\.txt$/i.test(source.file) ||
    source.license !== 'MIT' ||
    typeof source.repository !== 'string' ||
    !source.source?.startsWith('https://raw.githubusercontent.com/')
  )
    throw new Error(`Invalid pinned license source: ${key}`);
  const text = fs.readFileSync(path.join(licenseDirectory, source.file), 'utf8');
  if (createHash('sha256').update(text).digest('hex') !== source.sha256)
    throw new Error(`Pinned license text changed: ${key}`);
  extraLicenses[key] = { ...source, text };
}
fs.mkdirSync(path.join(web, 'src/control-plane'), { recursive: true });
fs.cpSync(
  path.join(root, 'integrations/hermes-workbench/src'),
  path.join(web, 'src/control-plane'),
  { recursive: true },
);
// Retain the actual upstream composer. Expose a narrow capability switch rather
// than presenting attachments, model settings or permission claims we cannot serve.
const composer = path.join(web, 'src/components/chat/goose-composer.tsx');
let text = fs.readFileSync(composer, 'utf8');
if (!text.includes('plainTextOnly?: boolean')) {
  function replace(a, b) {
    if (!text.includes(a)) throw Error('Upstream composer changed: ' + a);
    text = text.replace(a, b);
  }
  replace(
    'interface GooseComposerProps {',
    'interface GooseComposerProps {\n  plainTextOnly?: boolean;',
  );
  replace(
    'export function GooseComposer({',
    'export function GooseComposer({\n  plainTextOnly = false,',
  );
  replace(
    '<div className={s.leftTools}>',
    '<div className={s.leftTools}>\n            {plainTextOnly ? <span className={s.toolbarHint}>Ctrl + Enter 发送 · 工作区由协作引擎管理</span> : <>',
  );
  replace('          <div className={s.rightTools}>', '          <div className={s.rightTools}>');
  replace(
    '          </div>\n\n          <div className={s.rightTools}>',
    '            </>}\n          </div>\n\n          <div className={s.rightTools}>',
  );
  replace('onPaste={handlePaste}', 'onPaste={plainTextOnly ? undefined : handlePaste}');
  replace(
    'onDrop={handleDrop}',
    'onDrop={plainTextOnly ? (event) => event.preventDefault() : handleDrop}',
  );
  replace(
    '() => !skillToken && slashToken && !builtinSlash',
    '() => !plainTextOnly && !skillToken && slashToken && !builtinSlash',
  );
  fs.writeFileSync(composer, text);
}
const timeline = path.join(web, 'src/components/chat/message-timeline.tsx');
let timelineText = fs.readFileSync(timeline, 'utf8');
if (!timelineText.includes('enableSpeech?: boolean')) {
  timelineText = timelineText
    .replace(
      'interface MessageTimelineProps {',
      'interface MessageTimelineProps {\n  enableSpeech?: boolean;',
    )
    .replace('  autoTts = false,', '  autoTts = false,\n  enableSpeech = true,')
    .replace('speech={speechControls}', 'speech={enableSpeech ? speechControls : undefined}');
  fs.writeFileSync(timeline, timelineText);
}
// A turn jump is an explicit reading position, not a streaming follow request.
// Finish it synchronously so polling/layout updates cannot interrupt a smooth
// animation partway through and leave the reader near the previous position.
const immediateTurnJump = 'container.scrollTo({ top: targetTop, behavior: "auto" });';
if (!timelineText.includes(immediateTurnJump)) {
  const animatedTurnJump = 'container.scrollTo({ top: targetTop, behavior: "smooth" });';
  if (!timelineText.includes(animatedTurnJump))
    throw new Error('Upstream conversation turn navigation changed.');
  timelineText = timelineText.replace(animatedTurnJump, immediateTurnJump);
  fs.writeFileSync(timeline, timelineText);
}
// Completed/replayed messages can revise earlier blocks (for example the
// progress heading). Stop using the append-only streaming parser when settled.
const markdown = path.join(web, 'src/components/chat/markdown-renderer.tsx');
let markdownText = fs.readFileSync(markdown, 'utf8');
const settledMarkdownMode = 'mode={streaming ? "streaming" : "static"}';
if (!markdownText.includes(settledMarkdownMode)) {
  if (!markdownText.includes('mode="streaming"'))
    throw new Error('Upstream Markdown renderer mode changed.');
  markdownText = markdownText.replace('mode="streaming"', settledMarkdownMode);
  fs.writeFileSync(markdown, markdownText);
}
if (!markdownText.includes('useWorkspaceFileScope')) {
  const anchor = '  const normalizedText = useMemo(';
  if (
    !markdownText.includes(anchor) ||
    !markdownText.includes('rehypePlugins={streamdownRehypePlugins}')
  )
    throw new Error('Upstream Markdown file-link integration anchor changed.');
  markdownText =
    'import { useWorkspaceFileScope } from "@/control-plane/workspace-file-context";\nimport { rehypeWorkspaceFiles } from "@/control-plane/workspace-file-links";\n' +
    markdownText;
  markdownText = markdownText
    .replace(
      anchor,
      '  const fileScope = useWorkspaceFileScope();\n  const workspaceRehypePlugins = useMemo<ComponentProps<typeof Streamdown>["rehypePlugins"]>(() => [rehypeRaw, [rehypeWorkspaceFiles, fileScope], ...(streamdownRehypePlugins ?? []).slice(1)], [fileScope]);\n' +
        anchor,
    )
    .replace('rehypePlugins={streamdownRehypePlugins}', 'rehypePlugins={workspaceRehypePlugins}');
  fs.writeFileSync(markdown, markdownText);
}
fs.writeFileSync(
  path.join(web, 'control-plane.html'),
  '<!doctype html><html lang="zh-CN"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Hermes 工作台 · 协作引擎</title></head><body><div id="root"></div><script type="module" src="/src/control-plane/main.tsx"></script></body></html>',
);
fs.writeFileSync(
  path.join(web, 'vite.control-plane.config.ts'),
  `import {defineConfig} from 'vite';\nimport react from '@vitejs/plugin-react';\nimport path from 'node:path';\nimport {frontendLicenseNotices} from ${JSON.stringify(path.join(root, 'apps/web/license-notices.ts').replaceAll('\\', '/'))};\nconst sharedLicense = ${JSON.stringify(radixLicense)};\nconst supplements = ${JSON.stringify(extraLicenses)};\nexport default defineConfig({define:{__HERMES_BUILD_ID__: ${JSON.stringify(JSON.stringify(builtAt))}},plugins:[react(),frontendLicenseNotices((manifest) => { const repo = typeof manifest.repository === 'string' ? manifest.repository : manifest.repository?.url; const extra = supplements[manifest.name + '@' + manifest.version]; if (extra && extra.license === manifest.license && extra.repository === repo) return extra; return manifest.name.startsWith('@radix-ui/') && manifest.license === 'MIT' && repo === 'git+https://github.com/radix-ui/primitives.git' ? sharedLicense : undefined; })],resolve:{alias:{'@':path.resolve('src')}},build:{outDir:${JSON.stringify(webOutput)},emptyOutDir:false,rollupOptions:{input:path.resolve('control-plane.html')}}});\n`,
);
fs.writeFileSync(
  path.join(web, 'tsconfig.control-plane.json'),
  JSON.stringify(
    { extends: './tsconfig.json', include: ['src/control-plane', 'vite-env.d.ts'] },
    null,
    2,
  ),
);
const phases = process.argv.includes('--typecheck')
  ? [
      [
        'typecheck',
        ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.control-plane.json'],
      ],
    ]
  : [
      [
        'build',
        ['node_modules/vite/bin/vite.js', 'build', '--config', 'vite.control-plane.config.ts'],
      ],
    ];
for (const [name, args] of phases) {
  const result = spawnSync(process.execPath, args, {
    cwd: web,
    env: { ...process.env, PATH: path.dirname(process.execPath) + ';' + process.env.PATH },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 12 * 1024 * 1024,
  });
  fs.writeFileSync(path.join(run, name + '.log'), (result.stdout ?? '') + (result.stderr ?? ''));
  console.log((result.stdout ?? '') + (result.stderr ?? ''));
  if (result.error) console.error(result.error);
  if (result.status !== 0) {
    process.exitCode = result.status ?? 1;
    break;
  }
}
if (!process.exitCode && !process.argv.includes('--typecheck')) {
  fs.copyFileSync(path.join(webOutput, 'control-plane.html'), path.join(webOutput, 'index.html'));
  fs.copyFileSync(path.join(upstream, 'LICENSE'), path.join(webOutput, 'LICENSE-HERMES.txt'));
  fs.writeFileSync(
    path.join(webOutput, 'build-provenance.json'),
    JSON.stringify(
      {
        upstream: 'Eynzof/Hermes-CN-Desktop',
        commit: '06e15d0e5d3c27f1fd37f09579f26f91c020036e',
        builtAt,
        components: [
          'GooseComposer',
          'MessageTimeline',
          'SubagentPanel',
          'PanelHero',
          'shared-ui tokens',
        ],
        entry: 'integrations/hermes-workbench/src/main.tsx',
        engine: 'Existing control-plane HTTP API',
        nativeDesktop: false,
        licenseSupplements: [
          {
            source: radixLicense.source,
            sha256: createHash('sha256').update(radixLicense.text).digest('hex'),
          },
          ...Object.entries(extraSources).map(([key, source]) => ({ package: key, ...source })),
        ],
      },
      null,
      2,
    ),
  );
  if (!privateOutput)
    fs.copyFileSync(
      path.join(webOutput, 'build-provenance.json'),
      path.join(run, 'build-provenance.json'),
    );
  fs.writeFileSync(
    path.join(webOutput, 'workbench.json'),
    JSON.stringify(
      {
        version: 1,
        workbench: 'hermes',
        mode: 'real',
        profile: 'daily',
        uiBuildId: builtAt,
      },
      null,
      2,
    ),
  );
}
