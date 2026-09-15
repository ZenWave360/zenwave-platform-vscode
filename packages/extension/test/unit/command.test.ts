import assert from 'node:assert/strict';
import test from 'node:test';
import { buildSdkCommand, buildSdkInvocation } from '../../src/sdk/command.js';
import { parseModel } from '../../src/sdk/model.js';

const MODEL = `
@import("io.example:my-plugin:1.2.3")
@import("./shared/common.zdl")
config {
  basePackage "io.example.orders"
  targetFolder "."
  plugins {
    MainPlugin {
      targetFolder "build/generated"
      displayName "Orders API"
      sourceFile "${'${this.file.path}'}"
      --force
      --style=compact
    }
    FilesPlugin { zdlFiles "orders.zdl,customers.zdl" }
    StandalonePlugin (inherit false) { targetFolder "standalone" }
  }
}`;

const model = parseModel(MODEL);
assert.ok(model);
const main = model.plugins.find((plugin) => plugin.name === 'MainPlugin');
const files = model.plugins.find((plugin) => plugin.name === 'FilesPlugin');
const standalone = model.plugins.find((plugin) => plugin.name === 'StandalonePlugin');
assert.ok(main && files && standalone);

const settings = { cliCommand: 'jbang zw', extraArgs: [] } as const;

test('the plugin is passed with -p', () => {
  assert.match(buildSdkCommand(model, main, '/work/orders.zdl', settings), /^jbang zw -p MainPlugin /);
});

test('config options are inherited and plugin options override them once', () => {
  const command = buildSdkCommand(model, main, '/work/orders.zdl', settings);
  assert.match(command, /basePackage=io\.example\.orders/);
  assert.equal(command.match(/targetFolder=/g)?.length, 1);
  assert.match(command, /targetFolder=build\/generated/);
});

test('parser-normalized string values containing spaces are safely re-quoted', () => {
  assert.match(
    buildSdkCommand(model, main, '/work/orders.zdl', settings),
    /displayName="Orders API"/,
  );
});

test('(inherit false) omits enclosing config options', () => {
  const command = buildSdkCommand(model, standalone, '/work/orders.zdl', settings);
  assert.doesNotMatch(command, /basePackage=/);
  assert.match(command, /targetFolder=standalone/);
});

test('zdlFile is defaulted unless zdlFile or zdlFiles is declared', () => {
  assert.match(buildSdkCommand(model, main, '/work/orders.zdl', settings), /zdlFile=\/work\/orders\.zdl/);
  const declared = buildSdkCommand(model, files, '/work/orders.zdl', settings);
  assert.match(declared, /zdlFiles=orders\.zdl,customers\.zdl/);
  assert.doesNotMatch(declared, /zdlFile=/);
});

test('only Maven-coordinate imports become one --deps argument', () => {
  const command = buildSdkCommand(model, main, '/work/orders.zdl', settings);
  assert.match(command, /--deps io\.example:my-plugin:1\.2\.3/);
  assert.doesNotMatch(command, /shared\/common/);
});

test('${this.file.path} is substituted from the containing document', () => {
  assert.match(
    buildSdkCommand(model, main, '/work/orders.zdl', settings),
    /sourceFile=\/work\/orders\.zdl/,
  );
});

test('CLI options retain parser declaration order', () => {
  const command = buildSdkCommand(model, main, '/work/orders.zdl', settings);
  assert.ok(command.indexOf('--force') < command.indexOf('--style=compact'));
});

test('configured CLI and extra arguments wrap the assembled command', () => {
  const command = buildSdkCommand(model, main, '/work/orders.zdl', {
    cliCommand: 'zw',
    extraArgs: ['--debug', '--profile=local'],
  });
  assert.match(command, /^zw -p MainPlugin /);
  assert.match(command, /--debug --profile=local$/);
});

test('an injected Windows path is slash-normalized and quoted for bash', () => {
  const command = buildSdkCommand(
    model,
    main,
    'C:\\Users\\Ada\\My Project\\orders.zdl',
    settings,
  );
  assert.match(command, /sourceFile="C:\/Users\/Ada\/My Project\/orders\.zdl"/);
  assert.match(command, /zdlFile="C:\/Users\/Ada\/My Project\/orders\.zdl"/);
  assert.doesNotMatch(command, /\\Users/);
});

test('execution arguments preserve shell metacharacters as literal values', () => {
  const dangerousPlugin = {
    ...main,
    config: {
      ...main.config,
      expression: 'a;b $(touch /tmp/should-not-run) `uname` "$HOME" *.zdl',
    },
  };
  const invocation = buildSdkInvocation(model, dangerousPlugin, '/work/a;b/orders.zdl', settings);
  assert.ok(
    invocation.arguments.includes(
      'expression=a;b $(touch /tmp/should-not-run) `uname` "$HOME" *.zdl',
    ),
  );
  assert.ok(invocation.arguments.includes('zdlFile=/work/a;b/orders.zdl'));
  assert.match(
    invocation.commandLine,
    /'expression=a;b \$\(touch \/tmp\/should-not-run\) `uname` "\$HOME" \*\.zdl'/,
  );
  assert.match(invocation.commandLine, /zdlFile="\/work\/a;b\/orders\.zdl"/);
});

test('a quoted CLI command is split into executable and literal prefix arguments', () => {
  const invocation = buildSdkInvocation(model, main, '/work/orders.zdl', {
    cliCommand: '"/opt/ZenWave SDK/jbang" zw',
    extraArgs: [],
  });
  assert.equal(invocation.executable, '/opt/ZenWave SDK/jbang');
  assert.equal(invocation.arguments[0], 'zw');
  assert.match(invocation.commandLine, /^'\/opt\/ZenWave SDK\/jbang' zw /);
});

test('a quoted Windows executable path retains its backslashes', () => {
  const invocation = buildSdkInvocation(model, main, '/work/orders.zdl', {
    cliCommand: '"C:\\Program Files\\ZenWave\\zw.exe"',
    extraArgs: [],
  });
  assert.equal(invocation.executable, 'C:\\Program Files\\ZenWave\\zw.exe');
});
