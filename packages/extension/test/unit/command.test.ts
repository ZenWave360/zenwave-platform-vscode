import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSdkArguments,
  buildSdkCommand,
  findUnquotableArgument,
  splitCommandLine,
} from '../../src/sdk/command.js';
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
      maxDepth 3
      --force
      --style=compact
      --label="Orders API"
      --input="${'${this.file.path}'}"
    }
    FilesPlugin { zdlFiles "orders.zdl,customers.zdl" }
    StandalonePlugin (inherit false) { targetFolder "standalone" }
    InjectedPlugin {
      expression "a;b $(touch should-not-run) it's"
      --cli="$(touch should-not-run)"
    }
  }
}`;

const model = parseModel(MODEL);
assert.ok(model);
const plugin = (name: string) => {
  const found = model.plugins.find((candidate) => candidate.name === name);
  assert.ok(found, name);
  return found;
};
const main = plugin('MainPlugin');
const files = plugin('FilesPlugin');
const standalone = plugin('StandalonePlugin');
const injected = plugin('InjectedPlugin');

const settings = { cliCommand: 'jbang zw', extraArgs: [] } as const;
const posix = (declaration = main, filePath = '/work/orders.zdl', configured = settings) =>
  buildSdkCommand(model, declaration, filePath, configured, 'posix');

/** What a POSIX shell would pass to the SDK for a command line. */
const posixWords = (commandLine: string) => splitCommandLine(commandLine);

test('the plugin is passed with -p', () => {
  assert.match(posix(), /^jbang zw -p MainPlugin /);
});

test('config options are inherited and plugin options override them once', () => {
  const command = posix();
  assert.match(command, /basePackage=io\.example\.orders/);
  assert.equal(command.match(/targetFolder=/g)?.length, 1);
  assert.match(command, /targetFolder=build\/generated/);
});

test('parser-normalized string values containing spaces are safely re-quoted', () => {
  assert.match(posix(), /displayName="Orders API"/);
});

test('numeric option values are passed as their digits', () => {
  assert.match(posix(), / maxDepth=3 /);
});

test('(inherit false) omits enclosing config options', () => {
  const command = posix(standalone);
  assert.doesNotMatch(command, /basePackage=/);
  assert.match(command, /targetFolder=standalone/);
});

test('zdlFile is defaulted unless zdlFile or zdlFiles is declared', () => {
  assert.match(posix(), /zdlFile=\/work\/orders\.zdl/);
  const declared = posix(files);
  assert.match(declared, /zdlFiles=orders\.zdl,customers\.zdl/);
  assert.doesNotMatch(declared, /zdlFile=/);
});

test('only Maven-coordinate imports become one --deps argument', () => {
  const command = posix();
  assert.match(command, /--deps io\.example:my-plugin:1\.2\.3/);
  assert.doesNotMatch(command, /shared\/common/);
});

test('${this.file.path} is substituted from the containing document', () => {
  assert.match(posix(), /sourceFile=\/work\/orders\.zdl/);
});

test('CLI options keep declaration order and are quoted like any other value', () => {
  const command = posix(main, '/work/My Project/orders.zdl');
  assert.ok(command.indexOf('--force') < command.indexOf('--style=compact'));
  assert.ok(command.indexOf('--style=compact') < command.indexOf('--label="Orders API"'));
  assert.match(command, /--input="\/work\/My Project\/orders\.zdl"/);
});

test('configured CLI and extra arguments wrap the assembled command', () => {
  const command = posix(main, '/work/orders.zdl', {
    cliCommand: 'zw',
    extraArgs: ['--debug', '--profile=local'],
  });
  assert.match(command, /^zw -p MainPlugin /);
  assert.match(command, /--debug --profile=local$/);
});

test('an injected Windows path is slash-normalized and quoted for bash', () => {
  const command = posix(main, 'C:\\Users\\Ada\\My Project\\orders.zdl');
  assert.match(command, /sourceFile="C:\/Users\/Ada\/My Project\/orders\.zdl"/);
  assert.match(command, /zdlFile="C:\/Users\/Ada\/My Project\/orders\.zdl"/);
  assert.doesNotMatch(command, /\\Users/);
});

test('POSIX: model values that look like shell syntax reach the SDK literally', () => {
  const command = posix(injected, '/work/a;b/orders.zdl');
  const expected = buildSdkArguments(model, injected, '/work/a;b/orders.zdl', settings);
  assert.deepEqual(posixWords(command), ['jbang', 'zw', ...expected]);
  assert.ok(expected.includes("expression=a;b $(touch should-not-run) it's"));
  assert.ok(expected.includes('--cli=$(touch should-not-run)'));
  assert.match(command, /'expression=a;b \$\(touch should-not-run\) it'\\''s'/);
  assert.match(command, /'--cli=\$\(touch should-not-run\)'/);
  assert.match(command, /zdlFile="\/work\/a;b\/orders\.zdl"/);
});

test('PowerShell: values are single-quoted with doubled quotes and never expand', () => {
  const command = buildSdkCommand(model, injected, '/work/orders.zdl', settings, 'powershell');
  assert.match(command, /'expression=a;b \$\(touch should-not-run\) it''s'/);
  assert.match(command, /'--cli=\$\(touch should-not-run\)'/);
  assert.doesNotMatch(command, /"[^"]*\$/);
});

test('PowerShell: an argument containing a double quote is refused, POSIX runs it', () => {
  const quoted = { ...injected, config: { value: 'x"&calc&"' } };
  assert.equal(
    findUnquotableArgument(model, quoted, '/work/orders.zdl', settings, 'powershell'),
    'value=x"&calc&"',
  );
  assert.equal(findUnquotableArgument(model, quoted, '/work/orders.zdl', settings, 'posix'), undefined);
  assert.equal(findUnquotableArgument(model, main, '/work/orders.zdl', settings, 'powershell'), undefined);
});

test('PowerShell: commas are quoted, since they build arrays', () => {
  const command = buildSdkCommand(model, files, '/work/orders.zdl', settings, 'powershell');
  assert.match(command, /zdlFiles="orders\.zdl,customers\.zdl"/);
});

test('a quoted CLI command path is quoted for POSIX', () => {
  const command = posix(main, '/work/orders.zdl', {
    cliCommand: '"/opt/ZenWave SDK/jbang" zw',
    extraArgs: [],
  });
  assert.match(command, /^'\/opt\/ZenWave SDK\/jbang' zw -p /);
});

test('a Windows CLI command path is invoked, not echoed, in PowerShell', () => {
  const command = buildSdkCommand(
    model,
    main,
    '/work/orders.zdl',
    { cliCommand: '"C:\\Program Files\\jbang\\jbang.cmd" zw', extraArgs: [] },
    'powershell',
  );
  assert.match(command, /^& 'C:\\Program Files\\jbang\\jbang\.cmd' zw -p MainPlugin /);
});
