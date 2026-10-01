/** PC deployment profile. Contains paths and preferences only, never credentials. */
import fs from 'node:fs';
import path from 'node:path';

const record = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function keys(value, allowed, label) {
  if (!record(value)) throw new Error(`${label} must be an object.`);
  for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new Error(`Unknown ${label} field: ${key}`);
}
function absolute(value, label, optional = false) {
  if (optional && value === '') return '';
  if (typeof value !== 'string' || !value.trim() || !path.isAbsolute(value) || /[\x00-\x1f]/.test(value)) {
    throw new Error(`${label} must be an absolute path.`);
  }
  return path.resolve(value);
}
function boolean(value, label) {
  if (typeof value !== 'boolean') throw new Error(`${label} must be boolean.`);
  return value;
}

export function validatePcConfig(input) {
  keys(input, ['version','projectRoot','dshHome','workspace','logRoot','ports','startDesktop','skipCompliance','relay'], 'profile');
  if (input.version !== 1) throw new Error('Unsupported profile version.');
  keys(input.ports, ['desktop','dsh','gateway'], 'ports');
  for (const value of Object.values(input.ports)) if (!Number.isInteger(value) || value < 1 || value > 65535) throw new Error('Invalid port.');
  if (Object.keys(input.ports).length !== 3 || new Set(Object.values(input.ports)).size !== 3) throw new Error('Desktop, DSH and Gateway ports must be distinct.');
  keys(input.relay, ['enabled','bridgeConfigPath','frpcConfigPath','frpcExecutable'], 'relay');
  const enabled = boolean(input.relay.enabled, 'relay.enabled');
  if (enabled && input.ports.gateway !== 9445) throw new Error('The accepted relay upstream requires Gateway port 9445.');
  if (enabled && Object.values(input.ports).includes(9446)) throw new Error('Relay port 9446 must be distinct from DSH/Gateway ports.');
  return {
    version: 1,
    projectRoot: absolute(input.projectRoot, 'projectRoot'), dshHome: absolute(input.dshHome, 'dshHome'),
    workspace: absolute(input.workspace, 'workspace'), logRoot: absolute(input.logRoot, 'logRoot'),
    ports: { desktop:input.ports.desktop,dsh:input.ports.dsh,gateway:input.ports.gateway }, startDesktop: boolean(input.startDesktop, 'startDesktop'),
    skipCompliance: boolean(input.skipCompliance, 'skipCompliance'),
    relay: {
      enabled,
      bridgeConfigPath: absolute(input.relay.bridgeConfigPath, 'relay.bridgeConfigPath', !enabled),
      frpcConfigPath: absolute(input.relay.frpcConfigPath, 'relay.frpcConfigPath', !enabled),
      frpcExecutable: absolute(input.relay.frpcExecutable, 'relay.frpcExecutable', !enabled),
    },
  };
}

export function defaultPcConfig(projectRoot, userRoot) {
  return validatePcConfig({version:1, projectRoot, dshHome:path.join(userRoot,'dsh'), workspace:projectRoot,
    logRoot:path.join(userRoot,'logs'), ports:{desktop:3080,dsh:3081,gateway:9445}, startDesktop:false, skipCompliance:false,
    relay:{enabled:false,bridgeConfigPath:'',frpcConfigPath:'',frpcExecutable:''}});
}
export function defaultProfilePath(env = process.env) {
  return env.LOCALAPPDATA ? path.join(env.LOCALAPPDATA,'HarnessRemote','pc-config.json') : null;
}
export function readPcConfig(file) {
  if (fs.existsSync(`${file}.lock`)) throw new Error('Configuration write in progress; inspect the lock and backup before retrying.');
  const config = validatePcConfig(JSON.parse(fs.readFileSync(file,'utf8')));
  if (fs.existsSync(`${file}.lock`)) throw new Error('Configuration write in progress; retry after saving completes.');
  return config;
}
export function loadPcConfig({env = process.env} = {}) {
  const file = env.HARNESS_REMOTE_CONFIG || defaultProfilePath(env);
  if (!file || (!env.HARNESS_REMOTE_CONFIG && !fs.existsSync(file) && !fs.existsSync(`${file}.lock`))) return null;
  return readPcConfig(file);
}
export function productionOverrides(config) {
  return {dshHome:config.dshHome,workspace:config.workspace,dshPort:config.ports.dsh,gatewayPort:config.ports.gateway};
}
export function isProcessAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid,0); return true; } catch (error) { return error.code === 'EPERM'; }
}
export function assertSafeProfileChange(oldConfig, nextConfig, isAlive = isProcessAlive) {
  const file = path.join(oldConfig.dshHome,'remote','state','supervisor.json');
  if (!fs.existsSync(file)) return;
  let status;
  try { status = JSON.parse(fs.readFileSync(file,'utf8')); } catch { throw new Error('Cannot read current supervisor state; configuration was not changed.'); }
  const critical = (value) => JSON.stringify([value.projectRoot,value.dshHome,value.workspace,value.ports,value.relay]);
  if (isAlive(status.supervisor_pid) && critical(oldConfig) !== critical(nextConfig)) {
    throw new Error('The current supervisor is running. Stop it using the current profile before changing its paths, ports or relay.');
  }
}
export function savePcConfig(file, input, {isAlive = isProcessAlive} = {}) {
  const config = validatePcConfig(input);
  const content = `${JSON.stringify(config,null,2)}\n`;
  let backup = null;
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const lock = `${file}.lock`;
  let descriptor;
  try { descriptor = fs.openSync(lock,'wx'); }
  catch (error) { if (error.code === 'EEXIST') throw new Error('Configuration write in progress; inspect the lock before retrying.'); throw error; }
  const temporary = `${file}.${process.pid}-${Date.now()}.tmp`;
  let writing = false;
  let keepLock = false;
  try {
    fs.writeSync(descriptor,JSON.stringify({pid:process.pid,startedAt:new Date().toISOString()}));
    if (fs.existsSync(file)) {
      const old = validatePcConfig(JSON.parse(fs.readFileSync(file,'utf8')));
      if (JSON.stringify(old) === JSON.stringify(config)) return {changed:false,file,backup};
      assertSafeProfileChange(old,config,isAlive);
      backup = `${file}.backup.${Date.now()}-${process.pid}.json`;
      fs.copyFileSync(file,backup,fs.constants.COPYFILE_EXCL);
    }
    fs.writeFileSync(temporary,content,{encoding:'utf8',flag:'wx'});
    writing = true;
    try { fs.renameSync(temporary,file); }
    catch (error) {
      // EFS can reject rename within the same directory. Readers refuse the
      // write lock, and the previous profile is backed up before guarded copy.
      if (error.code !== 'EXDEV' || process.platform !== 'win32'
        || path.dirname(path.resolve(temporary)).toLowerCase() !== path.dirname(path.resolve(file)).toLowerCase()) throw error;
      fs.copyFileSync(temporary,file);
    }
    const saved = fs.openSync(file,'r+');
    try { fs.fsyncSync(saved); } finally { fs.closeSync(saved); }
  } catch (error) {
    if (writing) {
      try {
        if (backup) fs.copyFileSync(backup,file);
        else if (fs.existsSync(file)) fs.unlinkSync(file);
      } catch { keepLock = true; }
    }
    throw error;
  } finally {
    fs.closeSync(descriptor);
    try { if (fs.existsSync(temporary)) fs.unlinkSync(temporary); }
    finally { if (!keepLock) fs.unlinkSync(lock); }
  }
  return {changed:true,file,backup};
}
