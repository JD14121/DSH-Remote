import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { validatePcConfig, savePcConfig, readPcConfig, productionOverrides, loadPcConfig } from '../../src/remote/production/pc-config.mjs';

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-config-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, config: {
    version: 1, projectRoot: dir, dshHome: path.join(dir, 'state'), workspace: path.join(dir, 'work space'),
    logRoot: path.join(dir, 'logs'), ports: { desktop: 3080, dsh: 3081, gateway: 9445 },
    startDesktop: true, skipCompliance: false,
    relay: { enabled: false, bridgeConfigPath: '', frpcConfigPath: '', frpcExecutable: '' },
  } };
}

test('configuration drives Node paths and production ports from one source', (t) => {
  const {config} = fixture(t);
  config.ports.dsh = 3101;
  const resolved = validatePcConfig(config);
  assert.deepEqual(productionOverrides(resolved), { dshHome: config.dshHome, workspace: config.workspace, dshPort: 3101, gatewayPort: 9445 });
});
test('rejects unknown secret-bearing settings instead of persisting them', (t) => {
  const {config} = fixture(t);
  assert.throws(() => validatePcConfig({...config, token: 'do-not-save'}), /Unknown/);
  assert.throws(() => validatePcConfig({...config, relay: {...config.relay, privateKey: 'do-not-save'}}), /Unknown/);
});
test('rejects colliding desktop and production ports', (t) => {
  const {config} = fixture(t); config.ports.dsh = 3080;
  assert.throws(() => validatePcConfig(config), /distinct/);
});
test('rejects invalid ports and unsupported configuration versions', (t) => {
  const {config} = fixture(t);
  assert.throws(() => validatePcConfig({...config, version: 2}), /version/);
  assert.throws(() => validatePcConfig({...config, ports: {...config.ports, gateway: 0}}), /port/i);
});
test('relay mode requires existing-configuration references and the accepted upstream port', (t) => {
  const {config} = fixture(t);
  assert.throws(() => validatePcConfig({...config, relay: {...config.relay, enabled: true}}), /relay/i);
  const relay = {...config.relay, enabled: true, bridgeConfigPath: path.join(config.projectRoot,'bridge.json'), frpcConfigPath: path.join(config.projectRoot,'frpc.toml'), frpcExecutable: path.join(config.projectRoot,'frpc.exe')};
  assert.throws(() => validatePcConfig({...config, relay, ports: {...config.ports, gateway: 9500}}), /9445/);
});
test('absolute Unicode and spaced paths survive save and reload', (t) => {
  const {dir,config} = fixture(t);
  config.workspace = path.join(dir,'工作区 空格');
  const file = path.join(dir,'profile.json');
  savePcConfig(file,config);
  assert.equal(readPcConfig(file).workspace,config.workspace);
  assert.equal(fs.readFileSync(file)[0],'{'.charCodeAt(0));
});
test('saving an identical configuration is idempotent', (t) => {
  const {dir,config} = fixture(t); const file=path.join(dir,'profile.json');
  savePcConfig(file,config);
  assert.equal(savePcConfig(file,config).changed,false);
  assert.equal(fs.readdirSync(dir).filter(name=>name.includes('.backup.')).length,0);
});
test('GUI field ordering does not create a false configuration change', (t) => {
  const {dir,config}=fixture(t); const file=path.join(dir,'profile.json'); savePcConfig(file,config);
  const reordered={...config,ports:{gateway:9445,dsh:3081,desktop:3080}};
  assert.equal(savePcConfig(file,reordered).changed,false);
});
test('changed configuration gets a backup without moving workspace files', (t) => {
  const {dir,config} = fixture(t); const file=path.join(dir,'profile.json');
  fs.mkdirSync(config.workspace); fs.writeFileSync(path.join(config.workspace,'keep.txt'),'keep');
  savePcConfig(file,config);
  const result=savePcConfig(file,{...config,logRoot:path.join(dir,'new logs')});
  assert.equal(result.changed,true); assert.ok(fs.existsSync(result.backup));
  assert.equal(fs.readFileSync(path.join(config.workspace,'keep.txt'),'utf8'),'keep');
});
test('changing state location while the old supervisor is alive fails closed', (t) => {
  const {dir,config}=fixture(t); const file=path.join(dir,'profile.json'); savePcConfig(file,config);
  const stateDir=path.join(config.dshHome,'remote','state');fs.mkdirSync(stateDir,{recursive:true});
  fs.writeFileSync(path.join(stateDir,'supervisor.json'),JSON.stringify({supervisor_pid:123,state:'READY'}));
  assert.throws(()=>savePcConfig(file,{...config,dshHome:path.join(dir,'different')},{isAlive:()=>true}),/running/);
  assert.equal(readPcConfig(file).dshHome,config.dshHome);
});
test('an explicitly missing profile fails rather than silently selecting legacy paths', (t) => {
  const {dir}=fixture(t);
  assert.throws(()=>readPcConfig(path.join(dir,'missing.json')),/ENOENT/);
});
test('profile readers refuse a write in progress rather than reading partial JSON', (t) => {
  const {dir,config}=fixture(t);const file=path.join(dir,'profile.json');savePcConfig(file,config);
  fs.writeFileSync(`${file}.lock`,'writing');
  assert.throws(()=>readPcConfig(file),/in progress/);
  assert.throws(()=>savePcConfig(file,{...config,startDesktop:false}),/in progress/);
});
test('Windows user-data directories support first save and replacement', {skip:process.platform!=='win32'||!process.env.LOCALAPPDATA}, (t) => {
  const parent=path.join(process.env.LOCALAPPDATA,'HarnessRemote');
  fs.mkdirSync(parent,{recursive:true});
  const dir=fs.mkdtempSync(path.join(parent,'profile-test-'));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  const {config}=fixture(t); const file=path.join(dir,'profile.json');
  savePcConfig(file,config);
  savePcConfig(file,{...config,logRoot:path.join(dir,'new logs')});
  assert.equal(readPcConfig(file).logRoot,path.join(dir,'new logs'));
});

test('default loader refuses an interrupted initial installation', (t) => {
  const {dir}=fixture(t);const root=path.join(dir,'HarnessRemote');fs.mkdirSync(root);
  fs.writeFileSync(path.join(root,'pc-config.json.lock'),'writing');
  assert.throws(()=>loadPcConfig({env:{LOCALAPPDATA:dir}}),/in progress/);
});

test('an explicit portable profile overrides the machine default', (t) => {
  const {dir,config}=fixture(t);const file=path.join(dir,'custom.json');
  config.ports={desktop:32100,dsh:32101,gateway:32102};savePcConfig(file,config);
  assert.equal(loadPcConfig({env:{HARNESS_REMOTE_CONFIG:file,LOCALAPPDATA:dir}}).ports.dsh,32101);
});

test('CLI resolves custom paths and ports without preparing state or installing credentials', (t) => {
  const {dir,config}=fixture(t);const file=path.join(dir,'custom.json');savePcConfig(file,config);
  const output=execFileSync(process.execPath,['scripts/harness-config.mjs','--resolve','--config',file],{encoding:'utf8'});
  const result=JSON.parse(output);assert.equal(result.configured,true);
  assert.equal(result.supervisorState,path.join(config.dshHome,'remote','state','supervisor.json'));
  assert.equal(fs.existsSync(config.dshHome),false);
});

test('Windows status consumes custom profile instead of probing fixed production ports', {skip:process.platform!=='win32'}, (t) => {
  const {dir,config}=fixture(t);const file=path.join(dir,'custom.json');
  config.ports={desktop:32100,dsh:32101,gateway:32102};savePcConfig(file,config);
  const exe=path.join(process.env.SystemRoot,'System32','WindowsPowerShell','v1.0','powershell.exe');
  const output=execFileSync(exe,['-NoProfile','-ExecutionPolicy','Bypass','-File','scripts/dsh-status.ps1','-ConfigPath',file,'-Json'],{encoding:'utf8',windowsHide:true});
  const result=JSON.parse(output);assert.equal(result.dsh_port,32101);assert.equal(result.gateway_port,32102);
  assert.equal(result.supervisor_state,'NO-STATUS-FILE');assert.equal(result.credential_stored,false);
  assert.equal(fs.existsSync(config.dshHome),false);
});
