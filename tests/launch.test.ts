// @vitest-environment node
import { expect,it } from 'vitest';
import path from 'node:path';
import { launchRequest } from '../src/main/launch';
const cwd=path.resolve('launch-fixture');
it('opens positional files with spaces and Chinese names relative to the launching working directory',()=>{expect(launchRequest(['TodoLine.exe','记录 一.tde','子目录/记录二.TDE'],cwd,false)).toEqual({quit:false,files:[path.resolve(cwd,'记录 一.tde'),path.resolve(cwd,'子目录/记录二.TDE')]});});
it('skips Electron development entry points and supports repeated --open options',()=>{expect(launchRequest(['electron.exe','project','--force-device-scale-factor=2','--open','记录.tde','--open=另一份.tde'],cwd,true).files).toEqual([path.resolve(cwd,'记录.tde'),path.resolve(cwd,'另一份.tde')]);});
it('deduplicates Windows case variants and accepts unknown suffixes while rejecting URLs and invalid paths',()=>{expect(launchRequest(['app','记录.tde','记录.TDE','--unknown','https://example.com','abc.txt','bad\0.tde','--open'],cwd,false).files).toEqual([path.resolve(cwd,'记录.tde'),path.resolve(cwd,'abc.txt')]);});
it('recognizes remote quit, while arguments after -- are literal names',()=>{expect(launchRequest(['app','--quit'],cwd,false)).toEqual({files:[],quit:true});expect(launchRequest(['app','--','--quit','-记录.tde'],cwd,false)).toEqual({files:[path.resolve(cwd,'--quit'),path.resolve(cwd,'-记录.tde')],quit:false});});
