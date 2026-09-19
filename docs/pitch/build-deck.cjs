/* Rebuild: NODE_PATH=/tmp/conduit-pitch-tools/node_modules node docs/pitch/build-deck.cjs
 * Dependencies: pdfkit, pptxgenjs. Outputs share one set of editable layout primitives.
 */
const fs = require('node:fs');
const path = require('node:path');
const PDFDocument = require('pdfkit');
const pptxgen = require('pptxgenjs');
const OUT = __dirname;
const W = 1440, H = 810, U = 108;
const C = { paper: '#e7e2d6', ink: '#1a1815', gold: '#dda322', muted: '#5c574e', white: '#f6f2e9', green: '#14795f' };
const fontDir = '/usr/share/fonts/truetype/dejavu';
const fonts = { regular: 'DejaVuSans.ttf', bold: 'DejaVuSans-Bold.ttf', display: 'DejaVuSans-Bold.ttf' };
const pdf = new PDFDocument({size:[W,H],autoFirstPage:false,margin:0,info:{Title:'Conduit — Build on Stellar Hackathon',Author:'Conduit',Subject:'Five-slide pitch based on the supplied template'}});
const stream = fs.createWriteStream(path.join(OUT,'Conduit-Pitch-Deck.pdf')); pdf.pipe(stream);
for(const [k,v] of Object.entries(fonts)) pdf.registerFont(k,path.join(fontDir,v));
const pptx = new pptxgen(); pptx.layout='LAYOUT_WIDE';pptx.author='Conduit';pptx.subject='Build on Stellar Hackathon';pptx.title='Conduit — A programmable TRY–Stellar rail';pptx.lang='en-US';
pptx.theme={headFontFace:'DejaVu Sans',bodyFontFace:'DejaVu Sans',lang:'en-US'};
let slide, index=0;
const notes=[];
function rect(x,y,w,h,fill=C.ink,line){pdf.save().rect(x,y,w,h).fill(fill).restore();slide.addShape(pptx.ShapeType.rect,{x:x/U,y:y/U,w:w/U,h:h/U,fill:{color:fill.slice(1)},line:{color:(line||fill).slice(1),width:0}});}
function line(x1,y1,x2,y2,color=C.ink,width=2){pdf.save().lineWidth(width).strokeColor(color).moveTo(x1,y1).lineTo(x2,y2).stroke().restore();slide.addShape(pptx.ShapeType.line,{x:x1/U,y:y1/U,w:(x2-x1)/U,h:(y2-y1)/U,line:{color:color.slice(1),width:width*2/3}});}
function text(t,x,y,w,size=28,opt={}){
 const font=opt.bold?'bold':opt.display?'display':'regular', color=opt.color||C.ink, h=opt.h||size*1.45;
 pdf.font(font).fontSize(size).fillColor(color);
 for(const row of t.split('\n')) if(pdf.widthOfString(row)>w+2) throw Error(`Text too wide: ${row}`);
 pdf.text(t,x,y,{width:w,height:h,lineGap:opt.gap||0,lineBreak:true,align:opt.align||'left',link:opt.link});
 slide.addText(t,{x:x/U,y:(y-1)/U,w:w/U,h:h/U,margin:0,fontFace:'DejaVu Sans',fontSize:size*2/3,bold:!!(opt.bold||opt.display),color:color.slice(1),breakLine:false,vertAnchor:'top',valign:'top',paraSpaceAfter:0,align:opt.align||'left',...(opt.link?{hyperlink:{url:opt.link}}:{})});
}
function arrow(x,y,w=45){line(x,y,x+w,y,C.muted,2);line(x+w-9,y-7,x+w,y,C.muted,2);line(x+w-9,y+7,x+w,y,C.muted,2);}
function tag(t,x,y,w){rect(x,y,w,32,C.ink);text(t,x+12,y+5,w-24,16,{bold:true,color:C.gold});}
function base(section,title){index++;pdf.addPage();slide=pptx.addSlide();slide.background={color:C.paper.slice(1)};rect(0,0,W,H,C.paper);const bg=path.join(OUT,'assets/template-paper.png');pdf.image(bg,0,0,{width:W,height:H});slide.addImage({path:bg,x:0,y:0,w:W/U,h:H/U});
 text('CONDUIT',64,32,300,18,{bold:true});text('BUILD ON STELLAR  /  HACKATHON',880,34,496,16,{align:'right'});
 if(title){rect(64,96,1312,92,C.gold);text(title,84,105,1260,55,{display:true});}
 line(64,746,1376,746,C.muted,0.8);text(section.toUpperCase(),64,765,650,14,{color:C.muted});text(`STELLAR TESTNET   /   ${String(index).padStart(2,'0')}`,1056,765,320,14,{color:C.muted,align:'right'});
}
function note(title,body,sources){slide.addNotes(`${body}\n\nSources / preparation notes:\n${sources}`);notes.push({title,body,sources});}

base('A programmable TRY–Stellar rail');
tag('SCALE TRACK  /  TESTNET PROTOTYPE',64,112,402);
text('CONDUIT',56,170,1250,140,{display:true,h:180});
text('Your money. Your rules.',64,368,1300,59,{bold:true});
text('A programmable TRY–Stellar rail.',68,458,1240,33,{color:C.muted});
rect(64,562,1312,100,C.ink);
text('TRY',90,583,165,40,{bold:true,color:C.gold});arrow(268,612,58);
text('USDC',377,583,210,40,{bold:true,color:C.white});arrow(643,612,58);
text('YOUR RULE',750,591,330,30,{bold:true,color:C.white});arrow(1082,612,58);
text('YOU',1184,583,145,40,{bold:true,color:C.gold});
text('Bank connections are simulated through a TRY mock anchor.',68,689,1250,20,{color:C.muted});
note('01 — Conduit', 'Conduit is a programmable rail between Turkish lira and Stellar. The idea is simple: money arrives, follows a rule you chose, and stays under your control. Our strongest implementation is delegated portfolio allocation. You authorize its limits at setup; the contract checks every subsequent swap. Today, this is a testnet prototype with simulated bank transfers.', 'README.md: introduction, Status and limitations. Scale track is recorded in the README. The cover describes the product direction; the mandate guarantee applies to delegated portfolio mode.');

base('The solution','THE SOLUTION');
text('Set the rule.\nKeep control.',64,233,675,60,{bold:true,h:160});
text('Allocate incoming USDC automatically.\nKeep the assets in your own wallet.',68,430,690,28,{h:95,color:C.muted});
const items=[['01','You choose','Assets, spending cap and expiry.'],['02','The contract checks','Each swap must fit your mandate.'],['03','You can revoke','Stop the delegate with one call.']];
items.forEach((a,i)=>{const y=233+i*119;text(a[0],820,y,62,24,{bold:true,color:C.green});text(a[1],900,y-3,465,28,{bold:true});text(a[2],900,y+40,465,21,{color:C.muted});});
rect(64,605,1312,90,C.ink);text('The delegate can request a swap.',90,622,1230,26,{bold:true,color:C.white});text('The contract fixes the payout recipient to the owner.',90,660,1230,22,{color:C.gold});
note('02 — The solution','A user can say: allocate forty percent to XLM, thirty percent to AQUA, and leave the rest in USDC. They approve the token allowance and set a mandate during setup. The delegate then requests swaps, but the contract enforces the allowed assets, spending cap, price bounds and expiry. Proceeds return to the owner. The delegate cannot choose another recipient. This limits its authority, although unwanted trades within those limits can still cost fees and slippage. The owner can revoke the mandate.', 'contracts/mandate/src/lib.rs: set_mandate, execute, revoke; src/app/page.tsx: mandateApplies; src/lib/automation.ts: portfolio execution. The allowance and mandate are separate setup transactions, so do not claim a single signature for the whole onboarding flow.');

base('PMF / problem and target user','PMF');
text('Money follows a plan. People watch the screen.',64,222,1312,41,{bold:true});
text('Initial audience: people managing money across TRY and USDC.',68,294,1300,27,{color:C.muted});
const cards=[{x:64,n:'01',title:'Repeat decisions',a:'Every incoming payment',b:'means allocating again.'},{x:510,n:'02',title:'Manual execution',a:'Someone must return',b:'to the wallet to act.'},{x:956,n:'03',title:'Broad permissions',a:'A funded bot controls',b:'the budget it receives.'}];
cards.forEach(a=>{rect(a.x,363,420,182,C.white);text(a.n,a.x+22,380,70,21,{bold:true,color:C.green});text(a.title,a.x+22,419,375,27,{bold:true});text(a.a+'\n'+a.b,a.x+22,470,375,22,{h:68,color:C.muted});});
text('ILLUSTRATIVE FREELANCER RULE',68,584,1300,17,{bold:true,color:C.muted});
text('100 USDC arrives → 40% XLM + 30% AQUA + 30% USDC',68,618,1300,31,{bold:true});
text('PMF hypothesis: recurring allocation is valuable enough for repeat use.',68,684,1310,23,{color:C.muted});
note('03 — PMF','Start with a freelancer managing income across Turkish lira and USDC. They want the same allocation each time money arrives, without repeating the same wallet actions. For illustration, one hundred USDC could be split forty percent into XLM, thirty percent into AQUA, and thirty percent left in USDC. This is an example rule, not a recommended investment. Our hypothesis is that bounded automation makes recurring allocation useful enough to repeat. The next validation step is user interviews and a small pilot measuring setup completion and repeat use. We are not claiming proven product-market fit.', 'README.md: The problem and What it does; src/lib/ai/strategy.ts. Audience and pilot metrics are proposed positioning and validation steps, not measured adoption. No market-size, customer, revenue or savings figures are asserted.');

base('Technical workflow','TECHNICAL WORKFLOW');
text('From a deposit to a bounded swap.',64,221,1300,44,{bold:true});
const nodes=[['1','TRY deposit','Mock anchor','SEP-10 / 12 / 38 / 6'],['2','USDC arrives',"Owner’s wallet",'Browser watcher'],['3','Mandate checks','Soroban contract','Assets · cap · expiry'],['4','Swap + return','Soroswap router',"Output → owner"]];
nodes.forEach((a,i)=>{const x=64+i*338;rect(x,320,298,184,i===2?C.ink:C.white);const fg=i===2?C.white:C.ink;text(a[0],x+20,337,70,19,{bold:true,color:i===2?C.gold:C.green});text(a[1],x+20,377,265,27,{bold:true,color:fg});text(a[2],x+20,422,265,22,{color:fg});text(a[3],x+20,463,268,16,{color:i===2?C.gold:C.muted});if(i<3)arrow(x+303,409,30);});
text('One atomic execution: pull funds → swap → return proceeds.',68,535,1300,27,{bold:true});
line(64,589,1376,589,C.muted,1);
text('TODAY',68,611,180,17,{bold:true,color:C.green});text('Testnet • mock bank rail • open browser tab required',258,606,1100,25);
text('SCOPE',68,655,180,17,{bold:true,color:C.green});text('Mandate protection is active in portfolio mode.',258,650,1100,25);
text('NEXT',68,699,180,17,{bold:true,color:C.green});text('Background execution + production anchor integration',258,694,1100,25);
note('04 — Technical workflow','The anchor handles authentication, customer details, a quote, and the simulated TRY deposit. USDC arrives in the owner’s wallet. A browser watcher detects the payment and requests portfolio swaps through our Soroban mandate contract. Each allocation executes as one atomic pull, swap and return: if it fails, that transaction reverts. Stellar supplies the anchor standards and programmable settlement that connect these steps. The current watcher needs an open tab. Buy-and-sell mode uses a separately funded automation wallet; it does not have the same mandate protection. Next are background execution, per-asset bounds and a production anchor integration.', 'README.md: Stellar integration, Status and limitations, Roadmap; contracts/mandate/src/lib.rs: execute; src/app/page.tsx: mandateApplies; src/lib/automation.ts: POLL_INTERVAL_MS. Multiple allocations are separate transactions. The contract also enforces configured price bounds. Production anchor support has not been validated.');

base('The team','THE TEAM');
rect(64,241,210,210,C.ink);text('MK',74,289,190,83,{bold:true,color:C.gold,align:'center',h:112});
text('Murat Keskin',318,253,1000,51,{bold:true});
text('Project author / full-stack development',320,333,1000,28);
text('Soroban contract · Stellar integration · product interface',320,383,1040,25,{color:C.muted});
text('Built from the rule engine to the on-chain mandate.',68,502,1290,37,{bold:true});
text('NEXT MILESTONE',68,586,1290,17,{bold:true,color:C.green});
text('Validate recurring use. Bring the rail to a production anchor.',68,618,1300,29,{bold:true});
text('TRY THE TESTNET DEMO',68,692,350,17,{bold:true});
text('conduit-psi-three.vercel.app',460,684,610,23,{link:'https://conduit-psi-three.vercel.app'});
text('GitHub ↗',1197,684,179,23,{align:'right',link:'https://github.com/murat48/conduit'});
note('05 — The team','I am Murat Keskin, the project author. Conduit brings together the product interface, Stellar anchor integration and a custom Soroban mandate contract. The repository includes seventeen contract test cases covering behaviors such as spending limits, expiry, revocation and owner isolation. The next milestone is validating recurring use with users and integrating a production anchor. You can explore the testnet demo and source from the links on this slide. Conduit: your money, your rules.', 'Name is sourced from package.json author metadata; development role is inferred from project ownership and should be confirmed before presenting. No biography, employer, awards or adoption claims are added. Initials substitute for a team photo because none was provided. 17 #[test] cases are present in contracts/mandate/src/test.rs; tests were not rerun for this presentation. Demo URL is recorded in README.md, not availability-verified.');

pdf.end();
pptx.writeFile({fileName:path.join(OUT,'Conduit-Pitch-Deck.pptx')}).then(()=>console.log('PowerPoint written'));
fs.writeFileSync(path.join(OUT,'Speaker-Notes.md'),'# Conduit — Speaker notes\n\nEnglish pitch. Approximately 3–4 minutes, depending on pace.\n\n'+notes.map(n=>`## ${n.title}\n\n${n.body}\n\n**Sources / preparation notes:** ${n.sources}\n`).join('\n'));
fs.writeFileSync(path.join(OUT,'README.md'),'# Conduit pitch deck\n\nFive slides following the supplied Build on Stellar Hackathon PDF: cover, solution, PMF, technical workflow, team. All slide copy and speaker notes are in English.\n\n- `Conduit-Pitch-Deck.pdf`: presentation-ready export.\n- `Conduit-Pitch-Deck.pptx`: editable text, shapes and links; speaker notes included.\n- `Speaker-Notes.md`: pitch script and source notes.\n- `build-deck.cjs`: shared layout source for both exports.\n\nThe paper texture is extracted from the user-supplied template for use in this deck. Layout retains its cream, gold and dark palette. The event date and organizer confidentiality line are omitted from the project cover. No claim of organizer endorsement is made.\n\nTeam name comes from package.json; role awaits confirmation. A monogram is used because no photo was supplied. PMF is labeled as a hypothesis. No adoption, revenue, market-size or award claims are introduced. Demo availability and deployed contract state were not checked; product claims are based on the local README and implementation.\n\nRebuild with Node.js and `pdfkit` + `pptxgenjs` available to Node; DejaVu fonts are used. This environment: `NODE_PATH=/tmp/conduit-pitch-tools/node_modules node docs/pitch/build-deck.cjs`.\n');
stream.on('finish',()=>console.log('PDF written'));
