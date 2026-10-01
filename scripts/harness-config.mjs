/** Read-only diagnosis and explicit, protected PC profile installation. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultPcConfig, defaultProfilePath, readPcConfig, validatePcConfig, savePcConfig, assertSafeProfileChange } from '../src/remote/production/pc-config.mjs';
import { resolveProductionConfig } from '../src/remote/production/production-config.mjs';
import { validateR9ProductionConfig } from '../src/remote/r9/production-runtime.mjs';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const args = process.argv.slice(2);
const option = (name) => args.includes(name) ? args[args.indexOf(name)+1] : undefined;
const profilePath = option('--config') || process.env.HARNESS_REMOTE_CONFIG || defaultProfilePath();
const emit = (value) => process.stdout.write(`${JSON.stringify(value).replace(/[^\x00-\x7f]/g,(char)=>`\\u${char.charCodeAt(0).toString(16).padStart(4,'0')}`)}\n`);

function legacy() {
  const production = resolveProductionConfig();
  const programData = process.env.ProgramData || 'C:\\ProgramData';
  const appData = process.env.LOCALAPPDATA || project;
  const bridgeConfigPath = path.join(programData,'r9-relay','config','bridge.production.runtime.json');
  const frpcConfigPath = path.join(programData,'r9-relay','config','frpc.production.runtime.toml');
  const frpcExecutable = path.join(project,'.r9-fixture-tools','extract','frp_0.71.0_windows_amd64','frpc.exe');
  return validatePcConfig({version:1,projectRoot:project,dshHome:production.dshHome,workspace:production.workspace,
    logRoot:path.join(appData,'DSH-Remote','logs'),ports:{desktop:3080,dsh:production.dshPort,gateway:production.gatewayPort},
    startDesktop:true,skipCompliance:true,relay:{enabled:fs.existsSync(bridgeConfigPath)&&fs.existsSync(frpcConfigPath)&&fs.existsSync(frpcExecutable),
      bridgeConfigPath,frpcConfigPath,frpcExecutable}});
}
function resolve(forSetup = false) {
  if (profilePath && (fs.existsSync(profilePath) || fs.existsSync(`${profilePath}.lock`))) return {config:readPcConfig(profilePath),configured:true};
  if (!forSetup && (option('--config') || process.env.HARNESS_REMOTE_CONFIG)) throw new Error('The explicitly selected PC profile does not exist.');
  const existing = legacy();
  const hasLegacyState = fs.existsSync(path.join(existing.dshHome,'remote','state','supervisor.json'));
  return {config:hasLegacyState?existing:defaultPcConfig(project,path.dirname(profilePath||path.join(project,'pc-config.json'))),configured:false};
}
function diagnostics(config) {
  const checks=[];
  const check=(id,status,detail)=>checks.push({id,status,detail});
  const file=(id,value)=>check(id,fs.existsSync(value)&&fs.statSync(value).isFile()?'ok':'error',value);
  check('node',Number(process.versions.node.split('.')[0])>=24?'ok':'error',`Node ${process.versions.node}; requires 24+`);
  for(const name of ['package.json','scripts/remote-production.mjs','scripts/harness-start.ps1']) file(`project:${name}`,path.join(config.projectRoot,name));
  file('dependencies:ws',path.join(config.projectRoot,'node_modules','ws','package.json'));
  check('workspace',fs.existsSync(config.workspace)&&fs.statSync(config.workspace).isDirectory()?'ok':'error',config.workspace);
  check('dsh-data',fs.existsSync(config.dshHome)?'ok':'warning',fs.existsSync(config.dshHome)?config.dshHome:'DSH data root will be prepared securely on first start.');
  check('compliance',config.skipCompliance?'warning':'ok',config.skipCompliance?'Existing deployment compliance exception retained; not a fresh-install default.':'Compliance gate enabled.');
  if(config.relay.enabled) {
    for(const [id,value] of Object.entries(config.relay)) if(id!=='enabled') file(`relay:${id}`,value);
    try {
      const relay=validateR9ProductionConfig(JSON.parse(fs.readFileSync(config.relay.bridgeConfigPath,'utf8')));
      check('relay:bridge-policy','ok','Existing HTTPS, client CA, Origin, SNI, UI manifest and loopback policy validated.');
      const active=fs.readFileSync(config.relay.frpcConfigPath,'utf8').split(/\r?\n/).filter(line=>!/^\s*#/.test(line)).join('\n');
      const value=(key)=>{
        const raw=new RegExp(`^${key.replaceAll('.','\\.')}\\s*=\\s*("[^"\\n]*")\\s*$`,'m').exec(active)?.[1];
        return raw?JSON.parse(raw):null;
      };
      if((active.match(/^\s*\[\[proxies\]\]/gm)||[]).length!==1||value('type')!=='https'||value('localIP')!=='127.0.0.1'
        ||!/^localPort\s*=\s*9446\s*$/m.test(active)||!/^transport\.tls\.enable\s*=\s*true\s*$/m.test(active)
        ||!/^customDomains\s*=\s*\["relay\.drm-jd\.com"\]\s*$/m.test(active)||value('auth.method')!=='token'
        ||value('auth.tokenSource.type')!=='file'||/^auth\.token\s*=|^webServer\.|^includes\s*=/m.test(active)
        ||!value('transport.tls.serverName')||!value('serverAddr')||value('serverAddr').includes('R9_VPS_HOST')) throw new Error('FRPC configuration does not match the accepted HTTPS-only transport policy.');
      const keys=['transport.tls.certFile','transport.tls.keyFile','transport.tls.trustedCaFile','auth.tokenSource.file.path'];
      for(const key of keys) {
        const reference=value(key);
        if(!reference||!path.isAbsolute(reference)||!fs.existsSync(reference)) throw new Error(`Missing FRPC file reference: ${key}`);
        if([relay.androidClientCaPath,relay.httpsCertPath,relay.httpsKeyPath].map(p=>path.resolve(p).toLowerCase()).includes(path.resolve(reference).toLowerCase())) throw new Error('FRP and application TLS materials must be separate.');
      }
      check('relay:frpc-policy','ok','Separate FRP file references and the single loopback HTTPS proxy validated; secrets were not read.');
    } catch(error) { check('relay:policy','error',error.message); }
  } else check('mobile-relay','warning','Local PC setup only. Mobile access requires separate relay/certificate enrollment.');
  return {ready:!checks.some(item=>item.status==='error'),checks};
}

try {
  if(args.includes('--defaults')) {
    const old=resolve(true);
    const hasLegacyState=fs.existsSync(path.join(old.config.dshHome,'remote','state','supervisor.json'));
    const config=old.configured||hasLegacyState?old.config:defaultPcConfig(project,path.dirname(profilePath||path.join(project,'pc-config.json')));
    emit({config,configPath:profilePath,configured:old.configured});
  } else if(args.includes('--save')||args.includes('--check-input')) {
    const config=validatePcConfig(JSON.parse(fs.readFileSync(0,'utf8')));
    const diagnosis=diagnostics(config);
    if(args.includes('--check-input')) emit(diagnosis);
    else {
      if(!profilePath) throw new Error('Choose a configuration file path.');
      if(!diagnosis.ready) throw new Error('Configuration prerequisites are missing. Run diagnosis before saving.');
      const current=resolve(true);
      assertSafeProfileChange(current.config,config);
      emit({...savePcConfig(profilePath,config),diagnosis});
    }
  } else {
    const selected=resolve();
    emit(args.includes('--diagnose')?diagnostics(selected.config):{...selected.config,configured:selected.configured,configPath:selected.configured?profilePath:null,
      productionRoot:path.join(selected.config.dshHome,'remote'),supervisorState:path.join(selected.config.dshHome,'remote','state','supervisor.json')});
  }
} catch(error) { process.stderr.write(`Harness configuration: ${error.message}\n`);process.exitCode=1; }
