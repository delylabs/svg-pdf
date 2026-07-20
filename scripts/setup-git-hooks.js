import { execFileSync } from 'child_process';

execFileSync('git', ['config', 'core.hooksPath', 'scripts/hooks'], { stdio: 'inherit' });
console.log('Git hooks path set to scripts/hooks/');
