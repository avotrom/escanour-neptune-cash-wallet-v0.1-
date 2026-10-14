const fs=require('node:fs');const path=require('node:path');const {spawnSync}=require('node:child_process');
const root=path.join(__dirname,'../extension');
function files(dir){return fs.readdirSync(dir,{withFileTypes:true}).flatMap(e=>e.isDirectory()?files(path.join(dir,e.name)):e.name.endsWith('.js')?[path.join(dir,e.name)]:[]);}
const targets=files(root);for(const file of targets){const run=spawnSync(process.execPath,['--check',file],{encoding:'utf8'});if(run.status!==0){process.stderr.write(run.stderr);process.exit(run.status||1);}}
console.log(`Syntax checks passed for ${targets.length} JavaScript files.`);
