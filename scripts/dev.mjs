import './build.mjs';
import { spawn } from 'node:child_process';
const {default:electron}=await import('electron');
const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, ['.'], { stdio: 'inherit', env });
child.on('exit', code => process.exit(code ?? 0));
