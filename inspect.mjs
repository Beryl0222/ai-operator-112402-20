import {readFileSync} from 'node:fs';
import * as input from './inputs/noise-key.mjs';

const source=JSON.parse(readFileSync(new URL('./inputs/noise-key.json',import.meta.url),'utf8'));
console.log(JSON.stringify({名称:'扩散网格、白噪声身份和条件块',首项:source['grid'],字段:Object.keys(source),取数函数:Object.keys(input)},null,2));
