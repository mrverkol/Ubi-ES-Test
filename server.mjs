import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();
app.use(express.json({limit:"64kb"}));
app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method==="OPTIONS") return res.sendStatus(204);
  next();
});

const PORT=Number(process.env.PORT||3000);
const OPENAI_MODEL=process.env.OPENAI_MODEL||"gpt-5.6-luna";
const VALIDATOR_MODEL=process.env.VALIDATOR_MODEL||"gpt-5.6-sol";
const MIN_SOURCES=Number(process.env.MIN_SOURCES||2);
const MAX_SOURCES=Number(process.env.MAX_SOURCES||3);
const READY_TARGET=Number(process.env.JOKER_READY_TARGET||5);
const DB_FILE=process.env.JOKER_DB_FILE||path.join(process.cwd(),"joker-db.json");

const openai=new OpenAI({apiKey:process.env.OPENAI_API_KEY});
if(!process.env.OPENAI_API_KEY) console.warn("WARNING: OPENAI_API_KEY is not set.");

const games=new Map();
const jokerCategories=new Map();

function loadDb(){
  try{
    if(fs.existsSync(DB_FILE)){
      const raw=JSON.parse(fs.readFileSync(DB_FILE,"utf8"));
      for(const c of (raw.categories||[])){
        if(c&&c.key) jokerCategories.set(c.key,c);
      }
    }
  }catch(e){console.warn("Could not load Joker DB:",e.message)}
}
function saveDb(){
  try{
    const tmp=DB_FILE+".tmp";
    fs.writeFileSync(tmp,JSON.stringify({version:1,categories:[...jokerCategories.values()]},null,2),"utf8");
    fs.renameSync(tmp,DB_FILE);
  }catch(e){console.warn("Could not save Joker DB:",e.message)}
}
loadDb();

function error(res,code,message,status=400,extra={}){return res.status(status).json({status:"ERROR",error:{code,message,...extra}})}
function clean(v){return String(v??"").trim().replace(/\s+/g," ").slice(0,120)}
function key(v){return clean(v).toLocaleLowerCase("da-DK")}
function ensureGame(id){let g=games.get(id);if(!g){g={players:new Map()};games.set(id,g)}return g}
function ensurePlayer(gameId,playerId){
  const g=ensureGame(gameId);let p=g.players.get(String(playerId));
  if(!p){p={id:String(playerId),jokerCategory:null,jokerValidationId:null,jokerApproved:false,jokerUsed:false};g.players.set(String(playerId),p)}
  return p;
}
function getCategory(name){
  const k=key(name); return jokerCategories.get(k)||null;
}
function getOrCreateCategory(name){
  const cleanName=clean(name),k=key(cleanName);
  let c=jokerCategories.get(k);
  if(!c){
    c={id:"JC-"+crypto.randomUUID(),key:k,name:cleanName,createdAt:new Date().toISOString(),sources:[],questions:{}};
    for(let i=1;i<=6;i++)c.questions["N"+i]=[];
    jokerCategories.set(k,c);saveDb();
  }
  return c;
}
function isHttps(u){try{return new URL(u).protocol==="https:"}catch{return false}}
function domains(sources){return new Set(sources.map(s=>{try{return new URL(s.url).hostname}catch{return ""}}).filter(Boolean)).size}
function extractUrls(response){
  const out=[];
  for(const item of response.output||[]){
    if(item.type!=="message")continue;
    for(const c of item.content||[]){
      for(const a of c.annotations||[]){
        const u=a.url||a.source?.url;if(u&&isHttps(u))out.push(u);
      }
    }
  }
  return [...new Set(out)];
}
function parseJson(response){
  const t=response.output_text||"";
  try{return JSON.parse(t)}catch{
    const m=t.match(/\{[\s\S]*\}/);if(!m)throw new Error("MODEL_JSON_INVALID");return JSON.parse(m[0]);
  }
}
const sourceSchema={
  type:"object",additionalProperties:false,
  properties:{title:{type:"string"},url:{type:"string"},publisher:{type:"string"},publishedAt:{type:"string"},accessedAt:{type:"string"}},
  required:["title","url","publisher","publishedAt","accessedAt"]
};
const questionSchema={
  type:"object",additionalProperties:false,
  properties:{
    question:{type:"string"},answer:{type:"string"},level:{type:"string"},
    estimatedAnswerSeconds:{type:"integer"},sources:{type:"array",items:sourceSchema},
    sourceAgreement:{type:"boolean"},sourceQuality:{type:"string"}
  },
  required:["question","answer","level","estimatedAnswerSeconds","sources","sourceAgreement","sourceQuality"]
};

async function aiJson({model,instructions,input,schema,search=true}){
  const response=await openai.responses.create({
    model,instructions,input,
    tools:search?[{type:"web_search",search_context_size:"medium"}]:[],
    text:{format:{type:"json_schema",name:"ubi_es_joker",strict:true,schema}}
  });
  return {data:parseJson(response),response};
}

const VALIDATE_INSTRUCTIONS=`
Du er UBI ES Jokerkategori-validator.
En spiller vælger én selvstændig Jokerkategori. Jokerkategorien må være et emne, person, sted, hold, sport, band, hobby, historisk emne eller lignende, som kan danne grundlag for mange faktuelle quizspørgsmål.

Regler:
- Brug web search. Stol ikke på intern viden alene.
- Kategoriens emne skal være konkret og have tilstrækkelig dokumentation.
- Der skal kunne findes mindst to uafhængige, troværdige kilder.
- Jokerkategorien vurderes selvstændigt og må ikke begrænses af spillerens faste UBI ES-kategori.
- Returnér APPROVED når der er et solidt grundlag for en Joker-spørgsmålspulje.
- Returnér REJECTED hvis emnet er for uklart, for snævert eller utilstrækkeligt dokumenteret.
- Ved afvisning gives 2-3 relevante alternativer.
- Opfind aldrig kilder eller URL'er.
- Svar kun i JSON-schemaet.
`;

const GENERATE_INSTRUCTIONS=`
Du er UBI ES Joker Question Generator.
Generér en pulje af faktuelle quizspørgsmål om den allerede godkendte Jokerkategori.

UBI ES-regler:
- Spørgsmålet skal have ét entydigt korrekt svar.
- Det skal kunne besvares på højst 30 sekunder.
- Niveauet skal være N1-N6.
- Ingen ja/nej-spørgsmål, trickspørgsmål eller uklare definitioner.
- Spørgsmålene skal være forskellige fra hinanden.
- Brug web search og faktatjek oplysningerne.
- Brug mindst to uafhængige, troværdige kilder samlet set, og kilderne skal understøtte spørgsmål/svar.
- Returnér kun JSON efter schemaet.
`;

async function validateCategory(jokerCategory){
  if(!process.env.OPENAI_API_KEY)throw Object.assign(new Error("OPENAI_NOT_CONFIGURED"),{code:"OPENAI_NOT_CONFIGURED"});
  const {data,response}=await aiJson({
    model:VALIDATOR_MODEL,instructions:VALIDATE_INSTRUCTIONS,
    input:`Jokerkategori: ${jokerCategory}\nVurder om denne selvstændige Jokerkategori kan bruges i UBI ES.`,
    schema:{
      type:"object",additionalProperties:false,
      properties:{
        decision:{type:"string"},normalizedCategory:{type:"string"},reason:{type:"string"},
        alternatives:{type:"array",items:{type:"string"}},sources:{type:"array",items:sourceSchema},
        sourceAgreement:{type:"boolean"},sourceQuality:{type:"string"}
      },
      required:["decision","normalizedCategory","reason","alternatives","sources","sourceAgreement","sourceQuality"]
    }
  });
  const urls=extractUrls(response);
  const sources=(data.sources||[]).filter(s=>isHttps(s.url)&&(!urls.length||urls.includes(s.url)));
  return {approved:data.decision==="APPROVED"&&sources.length>=MIN_SOURCES&&domains(sources)>=2,data,sources};
}

async function generateBatch(jokerCategory,level,count){
  const schema={
    type:"object",additionalProperties:false,
    properties:{
      questions:{type:"array",minItems:count,maxItems:count,items:questionSchema}
    },
    required:["questions"]
  };
  const {data}=await aiJson({
    model:OPENAI_MODEL,instructions:GENERATE_INSTRUCTIONS,
    input:`Jokerkategori: ${jokerCategory}\nNiveau: ${level}\nGenerér præcis ${count} forskellige spørgsmål til puljen.`,
    schema
  });
  return Array.isArray(data.questions)?data.questions:[];
}

function usableQuestion(q,level){
  return q && q.question && q.answer && q.level===level &&
    Number.isInteger(q.estimatedAnswerSeconds)&&q.estimatedAnswerSeconds<=30 &&
    Array.isArray(q.sources)&&q.sources.length>=MIN_SOURCES&&domains(q.sources)>=2&&q.sourceAgreement===true;
}

app.get("/health",(req,res)=>res.json({
  status:"OK",service:"ubi-es-v1",aiConfigured:Boolean(process.env.OPENAI_API_KEY),
  model:OPENAI_MODEL,validatorModel:VALIDATOR_MODEL,jokerCategories:jokerCategories.size
}));

app.post("/api/v1/games/:gameId/players/:playerId/joker/validate",async(req,res)=>{
  const {gameId,playerId}=req.params;
  const jokerCategory=clean(req.body?.jokerCategory);
  if(jokerCategory.length<3)return error(res,"CATEGORY_TOO_NARROW","Skriv en Jokerkategori på mindst 3 tegn.",422);
  try{
    const result=await validateCategory(jokerCategory);
    if(!result.approved)return error(res,"CATEGORY_NOT_APPROVED",result.data.reason||"Jokerkategorien kan ikke godkendes.",422,{alternatives:result.data.alternatives||[]});
    const c=getOrCreateCategory(result.data.normalizedCategory||jokerCategory);
    for(const s of result.sources)if(!c.sources.some(x=>x.url===s.url))c.sources.push(s);
    const p=ensurePlayer(gameId,playerId);
    p.jokerCategory=c.name;p.jokerValidationId="JV-"+crypto.randomUUID();p.jokerApproved=true;p.jokerUsed=false;
    saveDb();
    return res.json({status:"APPROVED",jokerCategory:c.name,categoryId:c.id,validationId:p.jokerValidationId,validatedAt:new Date().toISOString()});
  }catch(e){
    console.error(e);
    return error(res,e.code==="OPENAI_NOT_CONFIGURED"?"OPENAI_NOT_CONFIGURED":"VALIDATOR_UNAVAILABLE","Joker-validatoren er midlertidigt utilgængelig.",503);
  }
});

app.post("/api/v1/games/:gameId/players/:playerId/joker/use",async(req,res)=>{
  const {gameId,playerId}=req.params;
  const level=/^N[1-6]$/.test(req.body?.level||"")?req.body.level:"N3";
  const p=games.get(gameId)?.players.get(String(playerId));
  if(!p)return error(res,"PLAYER_NOT_FOUND","Spilleren findes ikke.",404);
  if(!p.jokerApproved||!p.jokerCategory)return error(res,"JOKER_NOT_APPROVED","Jokerkategorien er ikke godkendt.",409);
  if(p.jokerUsed)return error(res,"JOKER_ALREADY_USED","Jokeren er allerede brugt.",409);
  const c=getCategory(p.jokerCategory);
  if(!c)return error(res,"JOKER_CATEGORY_NOT_FOUND","Jokerkategorien findes ikke i databasen.",404);
  try{
    let pool=c.questions[level]||[];
    let ready=pool.filter(q=>q.status==="READY");
    if(ready.length===0){
      const batch=await generateBatch(c.name,level,READY_TARGET);
      for(const q of batch){
        if(!usableQuestion(q,level))continue;
        const urls=[...new Set(q.sources.filter(s=>isHttps(s.url)).map(s=>s.url))];
        c.questions[level].push({
          id:"JQ-"+crypto.randomUUID(),status:"READY",question:q.question,answer:q.answer,level,
          estimatedAnswerSeconds:q.estimatedAnswerSeconds,sources:q.sources.slice(0,MAX_SOURCES),sourceUrls:urls,
          createdAt:new Date().toISOString()
        });
      }
      saveDb();
      pool=c.questions[level]||[];
      ready=pool.filter(q=>q.status==="READY");
    }
    if(!ready.length)return error(res,"NO_QUALIFIED_QUESTION","Joker-generatoren kunne ikke oprette et tilstrækkeligt dokumenteret spørgsmål.",409);
    const q=ready[0];
    q.status="USED";q.usedAt=new Date().toISOString();q.usedBy={gameId,playerId,turnId:req.body?.turnId||null};
    p.jokerUsed=true;
    saveDb();
    return res.json({
      status:"READY",questionId:q.id,jokerCategory:c.name,turnId:req.body?.turnId||null,
      question:q.question,answer:q.answer,level:q.level,
      estimatedAnswerSeconds:q.estimatedAnswerSeconds,sources:q.sources,sourceQuality:"VERIFIED"
    });
  }catch(e){
    console.error(e);
    return error(res,"GENERATOR_UNAVAILABLE","Joker-generatoren er midlertidigt utilgængelig.",503);
  }
});

app.listen(PORT,()=>console.log(`UBI ES v1.0 backend listening on ${PORT}`));
