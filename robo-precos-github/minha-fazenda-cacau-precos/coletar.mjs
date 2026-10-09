/* Robô de preços do Minha Fazenda Cacau
   Roda no GitHub Actions duas vezes por dia útil e grava dados/precos.json.
   - Preço diário da Bahia (convencional e certificado, R$/@): Mercado do Cacau, publicado pelo Notícias Agrícolas
   - Contrato de Nova York (US$/t): mesma página
   - Dólar comercial: AwesomeAPI
   - Série mensal (5 anos): Conab, preço recebido pelo produtor na Bahia (atualiza 1x por semana)
   Se uma fonte falhar, as outras continuam e o dado anterior é mantido. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const PASTA = path.dirname(fileURLToPath(import.meta.url));
const ARQ = path.join(PASTA, 'dados', 'precos.json');
const URL_DIARIO = 'https://www.noticiasagricolas.com.br/cotacoes/cacau';
const URL_DOLAR = 'https://economia.awesomeapi.com.br/json/last/USD-BRL';
const URL_CONAB = 'https://portaldeinformacoes.conab.gov.br/downloads/arquivos/PrecosMensalUF.txt';
const UA = 'MinhaFazendaCacau-robo/1.0 (atualizacao 2x/dia; contato via repositorio)';
const MESES = ['janeiro','fevereiro','março','abril','maio','junho','julho','agosto','setembro','outubro','novembro','dezembro'];

/* "1.109,00" -> 1109 ; "290,00" -> 290 ; "5582" -> 5582 ; "-1,69" -> -1.69 */
export function numeroBR(t){
  if(t===undefined || t===null) return null;
  let s = String(t).trim().replace(/\s/g,'');
  if(!s) return null;
  if(s.includes(',')) s = s.replace(/\./g,'').replace(',', '.');
  else if(/^\-?\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g,'');
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const ENT = {nbsp:' ', amp:'&', lt:'<', gt:'>', quot:'"', apos:"'", ccedil:'ç', atilde:'ã', otilde:'õ', aacute:'á', eacute:'é', iacute:'í', oacute:'ó', uacute:'ú', acirc:'â', ecirc:'ê', ocirc:'ô', agrave:'à', Ccedil:'Ç', Atilde:'Ã', Aacute:'Á', Eacute:'É'};
export function textoDeHtml(html){
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<\/(td|th)\s*>/gi, ' | ')
    .replace(/<\/(tr|p|div|li|h\d|table|caption|thead|tbody)\s*>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n)=>String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n)=>String.fromCharCode(parseInt(n,16)))
    .replace(/&([a-z]+);/gi, (m, e)=> (e in ENT) ? ENT[e] : m)
    .replace(/[ \t\r]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n');
}

/* procura a linha "BA <preço> <variação> Arroba" depois de um marcador */
function linhaBA(trecho){
  const re = /(?:^|\n|\|)\s*BA\s*\|?\s*([\d.]+,\d{2})\s*\|?\s*([-+]?\s?\d+(?:,\d+)?)?\s*%?\s*\|?\s*Arroba/i;
  const m = trecho.match(re);
  if(!m) return null;
  return {preco: numeroBR(m[1]), variacao: m[2] ? numeroBR(m[2].replace(/\s/g,'')) : null};
}

export function lerPaginaDiaria(html){
  const txt = textoDeHtml(html);
  const iBR = txt.search(/Cota[çc][ãa]o\s+Cacau\s+BR/i);
  if(iBR < 0) throw new Error('não achei a tabela "Cotação Cacau BR"');
  const bloco = txt.slice(iBR, iBR + 4000);
  const iConv = bloco.search(/Convencional/i);
  const iCert = bloco.search(/Certificado/i);
  if(iConv < 0) throw new Error('não achei a parte "Convencional"');
  const conv = linhaBA(bloco.slice(iConv, iCert > iConv ? iCert : undefined));
  const cert = iCert >= 0 ? linhaBA(bloco.slice(iCert)) : null;
  if(!conv || !conv.preco) throw new Error('não achei o preço BA convencional em arroba');
  const dt = bloco.match(/Atualizado\s+em:?\s*(\d{2})\/(\d{2})\/(\d{4})/i);
  const data = dt ? `${dt[3]}-${dt[2]}-${dt[1]}` : null;

  let ny = null;
  const iNY = txt.search(/Nova\s+Iorque|NYBOT|Nova\s+York/i);
  if(iNY >= 0){
    const reNY = new RegExp(`(${MESES.join('|')})\\s*\\/\\s*(\\d{2})\\s*\\|?\\s*([\\d.]+(?:,\\d+)?)\\s*\\|?\\s*([-+]?[\\d.]+(?:,\\d+)?)?`, 'i');
    const m = txt.slice(iNY, iNY + 3000).match(reNY);
    if(m) ny = {contrato: `${m[1][0].toUpperCase()+m[1].slice(1).toLowerCase()}/${m[2]}`, preco: numeroBR(m[3]), variacao: m[4] ? numeroBR(m[4]) : null};
  }
  /* faixa de segurança: preço de cacau na Bahia em R$/@ */
  if(conv.preco < 30 || conv.preco > 5000) throw new Error('preço convencional fora da faixa esperada: ' + conv.preco);
  if(cert && cert.preco && (cert.preco < 30 || cert.preco > 6000)) cert.preco = null;
  return {data, conv, cert, ny};
}

export function lerConab(texto){
  const linhas = texto.split(/\r?\n/);
  const cab = linhas[0].split(';').map(c=>c.trim().toLowerCase());
  const col = n => cab.indexOf(n);
  const iP = col('produto'), iUF = col('uf'), iAno = col('ano'), iMes = col('mes'), iNiv = col('dsc_nivel_comercializacao'), iVal = col('valor_produto_kg');
  if([iP,iUF,iAno,iMes,iNiv,iVal].some(i=>i<0)) throw new Error('cabeçalho da Conab mudou: ' + linhas[0]);
  const porMes = {};
  for(let k=1; k<linhas.length; k++){
    const c = linhas[k].split(';');
    if(c.length < cab.length) continue;
    const prod = c[iP].trim().toUpperCase();
    if(!prod.startsWith('CACAU')) continue;
    if(c[iUF].trim().toUpperCase() !== 'BA') continue;
    const niv = c[iNiv].trim().toUpperCase();
    if(!/RECEBIDO|PRODUTOR/.test(niv) || /PAGO/.test(niv)) continue;
    const ano = +c[iAno], mes = +c[iMes], kg = numeroBR(c[iVal]);
    if(!ano || !mes || !kg) continue;
    const ch = `${ano}-${String(mes).padStart(2,'0')}`;
    (porMes[ch] = porMes[ch] || []).push(kg);
  }
  return Object.keys(porMes).sort().map(ch=>{
    const v = porMes[ch]; const kg = v.reduce((s,x)=>s+x,0)/v.length;
    return {ano:+ch.slice(0,4), mes:+ch.slice(5), arroba: Math.round(kg*15*100)/100, fonte:'conab'};
  });
}

async function baixar(url, comoTexto=true, codificacao='utf-8'){
  const r = await fetch(url, {headers:{'User-Agent': UA, 'Accept-Language':'pt-BR'}});
  if(!r.ok) throw new Error(`${url} respondeu ${r.status}`);
  if(!comoTexto) return r.json();
  const buf = await r.arrayBuffer();
  return new TextDecoder(codificacao).decode(buf);
}

function hojeBrasil(){
  return new Date(Date.now() - 3*3600e3).toISOString().slice(0,10);
}

async function principal(){
  let atual = {versao:1, atualizadoEm:null, atual:null, diario:[], mensal:[], fontes:{}, status:{}};
  try{ atual = Object.assign(atual, JSON.parse(await fs.readFile(ARQ, 'utf8'))); }catch(e){}
  const status = Object.assign({}, atual.status);
  let mudou = false;

  /* 1. preço diário */
  try{
    const p = lerPaginaDiaria(await baixar(URL_DIARIO));
    const data = p.data || hojeBrasil();
    atual.atual = Object.assign({}, atual.atual||{}, {
      data, ba_convencional: p.conv.preco, var_convencional: p.conv.variacao,
      ba_certificado: p.cert ? p.cert.preco : null, var_certificado: p.cert ? p.cert.variacao : null,
      ny: p.ny
    });
    const dia = {data, conv: p.conv.preco, cert: p.cert ? p.cert.preco : null, ny: p.ny ? p.ny.preco : null};
    atual.diario = (atual.diario||[]).filter(d=>d.data!==data).concat([dia]).sort((a,b)=>a.data.localeCompare(b.data)).slice(-500);
    status.diario = 'ok'; status.diarioEm = new Date().toISOString(); mudou = true;
    console.log('Diário:', JSON.stringify(dia), '| NY:', JSON.stringify(p.ny));
  }catch(e){ status.diario = 'erro: ' + e.message; console.error('Diário falhou:', e.message); }

  /* 2. dólar */
  try{
    const j = await baixar(URL_DOLAR, false);
    const bid = Number(j.USDBRL && j.USDBRL.bid);
    if(bid > 1 && bid < 20){
      atual.atual = Object.assign({}, atual.atual||{}, {dolar: Math.round(bid*1000)/1000});
      const ult = (atual.diario||[])[atual.diario.length-1];
      if(ult && ult.data === (atual.atual && atual.atual.data)) ult.dolar = atual.atual.dolar;
      status.dolar = 'ok'; mudou = true;
      console.log('Dólar:', bid);
    }
  }catch(e){ status.dolar = 'erro: ' + e.message; console.error('Dólar falhou:', e.message); }

  /* 3. série mensal da Conab (uma vez por semana) */
  const idadeConab = status.conabEm ? (Date.now() - new Date(status.conabEm).getTime())/864e5 : 1e9;
  if(idadeConab > 7 || !(atual.mensal||[]).some(m=>m.fonte==='conab') || process.env.FORCAR_CONAB){
    try{
      const serie = lerConab(await baixar(URL_CONAB, true, 'latin1'));
      if(serie.length){
        const limite = new Date(); limite.setMonth(limite.getMonth() - 72);
        const corte = limite.getFullYear()*100 + limite.getMonth() + 1;
        atual.mensal = serie.filter(m=>m.ano*100+m.mes >= corte);
        status.conab = 'ok'; console.log('Conab:', atual.mensal.length, 'meses; último', JSON.stringify(atual.mensal[atual.mensal.length-1]));
      } else {
        status.conab = 'sem cacau na Bahia no arquivo da Conab';
        console.warn(status.conab);
      }
      status.conabEm = new Date().toISOString(); mudou = true;
    }catch(e){ status.conab = 'erro: ' + e.message; console.error('Conab falhou:', e.message); }
  }

  atual.fontes = {
    diario: 'Mercado do Cacau, publicado pelo Notícias Agrícolas',
    ny: 'Bolsa de Nova York (ICE), publicado pelo Notícias Agrícolas',
    dolar: 'AwesomeAPI (dólar comercial)',
    mensal: 'Conab — preço recebido pelo produtor, Bahia (R$/kg × 15)'
  };
  atual.status = status;
  if(mudou) atual.atualizadoEm = new Date().toISOString();
  await fs.mkdir(path.dirname(ARQ), {recursive:true});
  await fs.writeFile(ARQ, JSON.stringify(atual, null, 1) + '\n');
  if(String(status.diario||'').startsWith('erro') && !atual.atual){ process.exitCode = 1; }
}

if(process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])){
  principal().catch(e=>{ console.error(e); process.exitCode = 1; });
}
