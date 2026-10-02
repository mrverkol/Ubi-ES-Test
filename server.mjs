import express from "express";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import OpenAI from "openai";

const app = express();
app.use(express.json({ limit: "64kb" }));
app.use((req,res,next)=>{
  res.setHeader("Access-Control-Allow-Origin","*");
  res.setHeader("Access-Control-Allow-Methods","GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers","Content-Type");
  if(req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

const PORT = Number(process.env.PORT || 3000);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-6-luna";
const VALIDATOR_MODEL = process.env.VALIDATOR_MODEL || "gpt-6-luna";
const MIN_SOURCES = Number(process.env.MIN_SOURCES || 2);
const MAX_SOURCES = Number(process.env.MAX_SOURCES || 3);
const DB_FILE = process.env.JOKER_DB_FILE || path.join(process.cwd(), "joker-db.json");
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const games = new Map();
const jokerCategories = new Map();

function clean(v){ return String(v ?? "").trim().replace(/\s+/g," ").slice(0,120); }
function key(v){ return clean(v).toLocaleLowerCase("da-DK"); }
function isHttps(u){ try{return new URL(u).protocol === "https:";}catch{return false;} }
function error(res,code,message,status=400,extra={}){return res.status(status).json({status:"ERROR",error:{code,message,...extra}});}
function ensureGame(id){ let g=games.get(String(id)); if(!g){g={players:new Map()};games.set(String(id),g);} return g; }
function ensurePlayer(gameId,playerId){
  const g=ensureGame(gameId); const id=String(playerId); let p=g.players.get(id);
  if(!p){p={id,jokerCategory:null,jokerValidationId:null,jokerApproved:false,jokerUsed:false};g.players.set(id,p);}
  return p;
}
function uniqueDomains(sources){return new Set((sources||[]).map(s=>{try{return new URL(s.url).hostname}catch{return ""}}).filter(Boolean)).size;}
function parseJson(response){
  const t=response.output_text||"";
  try{return JSON.parse(t);}catch{const m=t.match(/\{[\s\S]*\}/);if(!m)throw new Error("MODEL_JSON_INVALID");return JSON.parse(m[0]);}
}
function extractUrls(response){
  const urls=[];
  for(const item of response.output||[]){
    if(item.type!=="message")continue;
    for(const c of item.content||[]){
      for(const a of c.annotations||[]){const u=a.url||a.source?.url;if(u&&isHttps(u))urls.push(u);}
    }
  }
  return [...new Set(urls)];
}

function loadDb(){
  try{
    if(!fs.existsSync(DB_FILE))return;
    const raw=JSON.parse(fs.readFileSync(DB_FILE,"utf8"));
    for(const c of raw.categories||[])if(c?.key)jokerCategories.set(c.key,c);
  }catch(e){console.warn("Joker DB load failed:",e.message);}
}
function saveDb(){
  try{
    const tmp=DB_FILE+".tmp";
    fs.writeFileSync(tmp,JSON.stringify({version:1,categories:[...jokerCategories.values()]},null,2),"utf8");
    fs.renameSync(tmp,DB_FILE);
  }catch(e){console.warn("Joker DB save failed:",e.message);}
}
function getCategory(name){return jokerCategories.get(key(name))||null;}
function getOrCreateCategory(name){
  const n=clean(name),k=key(n); let c=jokerCategories.get(k);
  if(!c){
    c={id:"JC-"+crypto.randomUUID(),key:k,name:n,createdAt:new Date().toISOString(),questions:{}};
    for(let i=1;i<=6;i++)c.questions["N"+i]=[];
    jokerCategories.set(k,c);saveDb();
  }
  return c;
}
loadDb();

const sourceSchema={
  type:"object",additionalProperties:false,
  properties:{title:{type:"string"},url:{type:"string"},publisher:{type:"string"},publishedAt:{type:"string"},accessedAt:{type:"string"}},
  required:["title","url","publisher","publishedAt","accessedAt"]
};

async function aiJson({model,instructions,input,schema,search=false,maxOutputTokens=900}){
  const response=await openai.responses.create({
    model,instructions,input,
    tools:search?[{type:"web_search",search_context_size:"low"}]:[],
    text:{format:{type:"json_schema",name:"ubi_es_joker",strict:true,schema}},
    max_output_tokens:maxOutputTokens
  });
  return {data:parseJson(response),response};
}

const VALIDATE_INSTRUCTIONS=`Du er UBI ES Jokerkategori-validator.\nVurder kun om teksten er en konkret, meningsfuld kategori, som kan bruges til faktuelle quizspørgsmål.\nGodkend normale konkrete emner som byer, lande, personer, sport, hold, musik, film, virksomheder, hobbyer og historiske emner.\nAfvis tomme, tilfældige eller meningsløse tekster.\nReturnér KUN JSON.`;

const QUESTION_INSTRUCTIONS=`Du er UBI ES Joker-spørgsmålsgenerator.\nLav ét kort, faktuelt quizspørgsmål om den godkendte Jokerkategori.\nSpørgsmålet skal have ét entydigt korrekt svar og kunne besvares på højst 30 sekunder.\nBrug web search og faktatjek oplysningerne.\nBrug mindst to uafhængige HTTPS-kilder.\nIngen ja/nej-spørgsmål, trickspørgsmål eller uklare formuleringer.\nReturnér KUN JSON.`;

async function validateCategory(category){
  if(!process.env.OPENAI_API_KEY)throw Object.assign(new Error("OPENAI_NOT_CONFIGURED"),{code:"OPENAI_NOT_CONFIGURED"});
  const {data}=await aiJson({
    model:VALIDATOR_MODEL,
    instructions:VALIDATE_INSTRUCTIONS,
    input:`Jokerkategori: ${category}`,
    search:false,
    maxOutputTokens:250,
    schema:{type:"object",additionalProperties:false,properties:{decision:{type:"string"},normalizedCategory:{type:"string"},reason:{type:"string"}},required:["decision","normalizedCategory","reason"]}
  });
  return {approved:data.decision==="APPROVED",data};
}

async function generateQuestion(category,level){
  const {data,response}=await aiJson({
    model:OPENAI_MODEL,
    instructions:QUESTION_INSTRUCTIONS,
    input:`Jokerkategori: ${category}\nNiveau: ${level}`,
    search:true,
    maxOutputTokens:1100,
    schema:{type:"object",additionalProperties:false,properties:{
      question:{type:"string"},answer:{type:"string"},level:{type:"string"},estimatedAnswerSeconds:{type:"integer"},
      sources:{type:"array",items:sourceSchema},sourceAgreement:{type:"boolean"},sourceQuality:{type:"string"}
    },required:["question","answer","level","estimatedAnswerSeconds","sources","sourceAgreement","sourceQuality"]}
  });
  return {data,response};
}

app.get("/health",(req,res)=>res.json({status:"OK",service:"ubi-es-v1",aiConfigured:Boolean(process.env.OPENAI_API_KEY),model:OPENAI_MODEL,validatorModel:VALIDATOR_MODEL,jokerCategories:jokerCategories.size}));

app.post("/api/v1/games/:gameId/players/:playerId/joker/validate",async(req,res)=>{
  const {gameId,playerId}=req.params;
  const category=clean(req.body?.jokerCategory ?? req.body?.topic ?? req.body?.jokerTopic);
  if(category.length<3)return error(res,"TOPIC_TOO_NARROW","Skriv en Jokerkategori på mindst 3 tegn.",422,{alternatives:[]});
  try{
    const result=await validateCategory(category);
    if(!result.approved)return error(res,"CATEGORY_NOT_APPROVED",result.data.reason||"Jokerkategorien kan ikke godkendes.",422,{alternatives:[]});
    const c=getOrCreateCategory(result.data.normalizedCategory||category);
    const p=ensurePlayer(gameId,playerId);
    p.jokerCategory=c.name;p.jokerValidationId="JV-"+crypto.randomUUID();p.jokerApproved=true;p.jokerUsed=false;
    saveDb();
    return res.json({status:"APPROVED",jokerCategory:c.name,categoryId:c.id,validationId:p.jokerValidationId,validatedAt:new Date().toISOString()});
  }catch(e){
    console.error(e);
    const msg=e?.code==="insufficient_quota"?"OpenAI-kontoen mangler API-kredit.":e?.code==="rate_limit_exceeded"?"OpenAI-grænsen blev nået. Prøv igen om lidt.":"Joker-validatoren er midlertidigt utilgængelig.";
    return error(res,e?.code==="OPENAI_NOT_CONFIGURED"?"OPENAI_NOT_CONFIGURED":"VALIDATOR_UNAVAILABLE",msg,503);
  }
});

app.post("/api/v1/games/:gameId/players/:playerId/joker/use",async(req,res)=>{
  const {gameId,playerId}=req.params;
  let p=games.get(String(gameId))?.players.get(String(playerId));

  // Render can restart/spin down the Node process between validation and use.
  // In that case the in-memory player Map is empty. Rehydrate the approved
  // Joker player from the validated category sent by the frontend.
  if(!p){
    const requestedCategory=clean(req.body?.jokerCategory);
    const c0=getCategory(requestedCategory);
    if(!c0){
      console.warn("JOKER USE PLAYER_NOT_FOUND", {gameId,playerId,hasCategory:Boolean(requestedCategory)});
      return error(res,"PLAYER_NOT_FOUND","Spilleren findes ikke.",404);
    }
    p=ensurePlayer(gameId,playerId);
    p.jokerCategory=c0.name;
    p.jokerApproved=true;
    p.jokerUsed=false;
  }

  if(!p.jokerApproved||!p.jokerCategory)return error(res,"JOKER_NOT_APPROVED","Jokerkategorien er ikke godkendt.",409);
  if(p.jokerUsed)return error(res,"JOKER_ALREADY_USED","Jokeren er allerede brugt.",409);
  const level=/^N[1-6]$/.test(req.body?.level||"")?req.body.level:"N3";
  if(!p.jokerCategory && req.body?.jokerCategory){
    const c0=getCategory(req.body.jokerCategory);
    if(c0){p.jokerCategory=c0.name;p.jokerApproved=true;}
  }
  const c=getCategory(p.jokerCategory)||getOrCreateCategory(p.jokerCategory);
  try{
    let ready=(c.questions[level]||[]).find(q=>q.status==="READY");
    if(!ready){
      const {data,response}=await generateQuestion(c.name,level);
      const urls=extractUrls(response);
      const sources=(data.sources||[]).filter(s=>isHttps(s.url));
      const usableSources=sources.filter(s=>!urls.length||urls.includes(s.url));
      const valid=data.question&&data.answer&&data.level===level&&Number.isInteger(data.estimatedAnswerSeconds)&&data.estimatedAnswerSeconds<=30&&data.sourceAgreement===true&&usableSources.length>=MIN_SOURCES&&uniqueDomains(usableSources)>=2;
      if(!valid)return error(res,"NO_QUALIFIED_QUESTION","Der kunne ikke genereres et tilstrækkeligt dokumenteret Joker-spørgsmål.",409);
      ready={id:"JQ-"+crypto.randomUUID(),status:"READY",question:data.question,answer:data.answer,level,estimatedAnswerSeconds:data.estimatedAnswerSeconds,sources:usableSources.slice(0,MAX_SOURCES),createdAt:new Date().toISOString()};
      c.questions[level].push(ready);saveDb();
    }
    ready.status="USED";ready.usedAt=new Date().toISOString();ready.usedBy={gameId,playerId,turnId:req.body?.turnId||null};
    p.jokerUsed=true;saveDb();
    return res.json({status:"READY",questionId:ready.id,jokerCategory:c.name,turnId:req.body?.turnId||null,question:ready.question,answer:ready.answer,level:ready.level,estimatedAnswerSeconds:ready.estimatedAnswerSeconds,sources:ready.sources,sourceQuality:"VERIFIED"});
  }catch(e){
    console.error(e);
    const msg=e?.code==="insufficient_quota"?"OpenAI-kontoen mangler API-kredit.":e?.code==="rate_limit_exceeded"?"OpenAI-grænsen blev nået. Prøv igen om lidt.":"Joker-generatoren er midlertidigt utilgængelig.";
    return error(res,"GENERATOR_UNAVAILABLE",msg,503);
  }
});

app.listen(PORT,()=>console.log(`UBI ES v1.0 backend listening on ${PORT}`));
