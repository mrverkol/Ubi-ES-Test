import express from "express";
import crypto from "crypto";
import OpenAI from "openai";

const app = express();

/* CORS: allow GitHub Pages frontend to receive API responses */
const configuredOrigins = String(
  process.env.FRONTEND_ORIGIN || "https://mrverkol.github.io"
)
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

const allowedOrigins = new Set([
  "https://mrverkol.github.io",
  ...configuredOrigins
]);

app.use((req, res, next) => {
  const origin = req.headers.origin;

  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  }

  if (req.method === "OPTIONS") {
    return res.sendStatus(204);
  }

  next();
});

app.use(express.json({ limit: "64kb" }));
const PORT = Number(process.env.PORT || 3000);
const OPENAI_MODEL = process.env.OPENAI_MODEL || "gpt-5.6-luna";
const VALIDATOR_MODEL = process.env.VALIDATOR_MODEL || "gpt-5.6-sol";
const MAX_SOURCES = Number(process.env.MAX_SOURCES || 3);
const MIN_SOURCES = Number(process.env.MIN_SOURCES || 2);

if (!process.env.OPENAI_API_KEY) {
  console.warn("WARNING: OPENAI_API_KEY is not set. Joker AI endpoints will return 503.");
}
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

const games = new Map();

const CATEGORIES = new Set([
  "GEOGRAFI","HISTORIE","SPORT","MUSIK","FILM","TV_SERIER",
  "NATUR_DYR","VIDENSKAB_TEKNologi","MAD_DRIKKE",
  "KULTUR_LITTERATUR","SAMFUND_VERDEN","ALMEN_VIDEN"
]);

function error(res, code, message, status=400, extra={}) {
  return res.status(status).json({ status:"ERROR", error:{ code, message, ...extra } });
}
function cleanTopic(v) {
  return String(v ?? "").trim().replace(/\s+/g," ").slice(0,120);
}
function validCategory(c) { return CATEGORIES.has(c); }
function ensureGame(gameId) {
  let g = games.get(gameId);
  if (!g) { g = { players:new Map() }; games.set(gameId,g); }
  return g;
}
function ensurePlayer(gameId, playerId) {
  const g = ensureGame(gameId);
  let p = g.players.get(playerId);
  if (!p) { p = { id:playerId, joker:null, jokerUsed:false }; g.players.set(playerId,p); }
  return p;
}
function isHttpsUrl(u) {
  try { return new URL(u).protocol === "https:"; } catch { return false; }
}
function uniqueDomains(sources) {
  return new Set(sources.map(s => { try { return new URL(s.url).hostname; } catch { return ""; } }).filter(Boolean)).size;
}
function extractUrlsFromResponse(response) {
  const urls = [];
  for (const item of (response.output || [])) {
    if (item.type !== "message") continue;
    for (const c of (item.content || [])) {
      const anns = c.annotations || [];
      for (const a of anns) {
        const u = a.url || a.source?.url;
        if (u && isHttpsUrl(u)) urls.push(u);
      }
    }
  }
  return [...new Set(urls)];
}
function parseJson(response) {
  const text = response.output_text || "";
  try { return JSON.parse(text); } catch {
    const m = text.match(/\{[\s\S]*\}/);
    if (!m) throw new Error("MODEL_JSON_INVALID");
    return JSON.parse(m[0]);
  }
}

const sourceSchema = {
  type:"object",
  additionalProperties:false,
  properties:{
    title:{type:"string"},
    url:{type:"string"},
    publisher:{type:"string"},
    publishedAt:{type:"string"},
    accessedAt:{type:"string"}
  },
  required:["title","url","publisher","publishedAt","accessedAt"]
};

async function aiJson({model,instructions,input,search=true}) {
  const response = await openai.responses.create({
    model,
    instructions,
    input,
    tools: search ? [{type:"web_search", search_context_size:"medium"}] : [],
    text: {
      format: {
        type:"json_schema",
        name:"ubi_es_joker",
        strict:true,
        schema:{
          type:"object",
          additionalProperties:false,
          properties:{
            decision:{type:"string"},
            normalizedTopic:{type:"string"},
            reason:{type:"string"},
            alternatives:{type:"array",items:{type:"string"}},
            question:{type:"string"},
            answer:{type:"string"},
            level:{type:"string"},
            estimatedAnswerSeconds:{type:"integer"},
            sources:{type:"array",items:sourceSchema},
            sourceAgreement:{type:"boolean"},
            sourceQuality:{type:"string"}
          },
          required:[
            "decision","normalizedTopic","reason","alternatives","question",
            "answer","level","estimatedAnswerSeconds","sources",
            "sourceAgreement","sourceQuality"
          ]
        }
      }
    }
  });
  return { data:parseJson(response), response };
}

const VALIDATE_INSTRUCTIONS = `
Du er UBI ES Joker Validator.
Formålet er at afgøre, om et spilleremne er bredt og veldokumenteret nok til at generere kvalificerede quizspørgsmål inden for den valgte faste kategori.

Regler:
- Brug web search. Stol ikke på din interne viden alene.
- Emnet skal være konkret nok til at give flere entydige, faktuelle spørgsmål.
- Det skal være muligt at finde mindst to uafhængige, troværdige kilder.
- Vurder emnet inden for den valgte UBI ES-kategori.
- Hvis emnet er for snævert, returnér REJECTED og 2-3 bredere, relevante alternativer.
- Returnér APPROVED kun når kildedækningen er tilstrækkelig.
- Du må ikke opfinde kilder eller URL'er.
- Svar kun i det angivne JSON-schema.
`;

const GENERATE_INSTRUCTIONS = `
Du er UBI ES Joker Question Generator + Validator.
Lav ét quizspørgsmål om det allerede godkendte emne inden for den allerede godkendte kategori.

UBI ES-regler:
- Spørgsmålet skal have ét entydigt korrekt svar.
- Det skal kunne besvares på højst 30 sekunder.
- Niveauet skal være N1-N6 og svare til almindelig UBI ES-sværhedsstandard.
- Undgå ja/nej-spørgsmål, uklare formuleringer, trickspørgsmål og spørgsmål hvor svaret afhænger af en tvivlsom definition.
- Brug web search og faktatjek oplysningerne.
- Brug mindst to uafhængige, troværdige kilder.
- Kilderne skal understøtte selve spørgsmålet og svaret.
- Hvis kilderne er uenige eller utilstrækkelige, returnér REJECTED.
- Opfind aldrig kilde, titel, dato eller URL.
- Returnér kun JSON efter schemaet.
`;

async function validateTopic({gameId,playerId,categoryId,topic}) {
  if (!process.env.OPENAI_API_KEY) throw Object.assign(new Error("OPENAI_NOT_CONFIGURED"),{code:"OPENAI_NOT_CONFIGURED"});
  const {data,response} = await aiJson({
    model:VALIDATOR_MODEL,
    instructions:VALIDATE_INSTRUCTIONS,
    input:`Kategori: ${categoryId}\nSpillerens Joker-emne: ${topic}\nVurder om emnet kan bruges.`,
    search:true
  });
  const urls = extractUrlsFromResponse(response);
  const sources = Array.isArray(data.sources) ? data.sources.filter(s=>isHttpsUrl(s.url)) : [];
  const usableSources = sources.filter(s=>urls.length===0 || urls.includes(s.url));
  const enoughSources = usableSources.length >= MIN_SOURCES && uniqueDomains(usableSources) >= 2;
  const approved = data.decision === "APPROVED" && enoughSources;
  return {approved,data,sources:usableSources};
}

app.get("/health", (_,res)=>res.json({
  status:"OK", service:"ubi-es-v1", aiConfigured:Boolean(process.env.OPENAI_API_KEY),
  model:OPENAI_MODEL, validatorModel:VALIDATOR_MODEL
}));

/* Frontend/backend registration: the backend becomes the authoritative Joker state. */
app.post("/api/v1/games/:gameId/players/:playerId/joker/validate", async (req,res)=>{
  const {gameId,playerId}=req.params;
  const {categoryId,topic}=req.body||{};
  if(!categoryId || !topic) return error(res,"INVALID_REQUEST","categoryId og topic er påkrævet.",400);
  if(!validCategory(categoryId)) return error(res,"INVALID_CATEGORY","Ugyldig UBI ES-kategori.",422);
  const clean=cleanTopic(topic);
  if(clean.length<3) return error(res,"TOPIC_TOO_NARROW","Dit emne er for snævert til at vi kan lave kvalificerede spørgsmål.",422,{alternatives:[]});
  try {
    const result=await validateTopic({gameId,playerId,categoryId,topic:clean});
    if(!result.approved) {
      return error(res,"TOPIC_TOO_NARROW",
        result.data.reason || "Dit emne er for snævert til at vi kan lave kvalificerede spørgsmål.",
        422,{alternatives:result.data.alternatives||[]});
    }
    const validationId="JV-"+crypto.randomUUID();
    const p=ensurePlayer(gameId,playerId);
    p.joker={categoryId,topic:clean,normalizedTopic:result.data.normalizedTopic,
      validationId,status:"APPROVED",validatedAt:new Date().toISOString()};
    return res.json({status:"APPROVED",categoryId,topic:clean,
      normalizedTopic:result.data.normalizedTopic,validationId,
      validatedAt:p.joker.validatedAt});
  } catch(e) {
    console.error(e);
    return error(res,e.code==="OPENAI_NOT_CONFIGURED"?"OPENAI_NOT_CONFIGURED":"VALIDATOR_UNAVAILABLE",
      "Joker-validatoren er midlertidigt utilgængelig.",503);
  }
});

/* Generate only from the server-side approved category + topic. */
app.post("/api/v1/games/:gameId/players/:playerId/joker/use", async (req,res)=>{
  const {gameId,playerId}=req.params;
  const {turnId,level}=req.body||{};
  const p=games.get(gameId)?.players.get(playerId);
  if(!p) return error(res,"PLAYER_NOT_FOUND","Spilleren findes ikke.",404);
  if(p.jokerUsed) return error(res,"JOKER_ALREADY_USED","Jokeren er allerede brugt.",409);
  if(!p.joker || p.joker.status!=="APPROVED") return error(res,"JOKER_NOT_APPROVED","Joker-emnet er ikke godkendt.",409);

  const categoryId=p.joker.categoryId, topic=p.joker.topic;
  const requestedLevel=/^N[1-6]$/.test(level||"") ? level : "N3";

  try {
    const {data,response}=await aiJson({
      model:OPENAI_MODEL,
      instructions:GENERATE_INSTRUCTIONS,
      input:`Fast kategori: ${categoryId}\nGodkendt Joker-emne: ${topic}\nØnsket niveau: ${requestedLevel}\nMaksimal løsningstid: 30 sekunder.`,
      search:true
    });

    const urls=extractUrlsFromResponse(response);
    const sources=(data.sources||[]).filter(s=>isHttpsUrl(s.url));
    const domains=uniqueDomains(sources);
    const ready =
      data.decision==="APPROVED" &&
      data.question && data.answer &&
      /^N[1-6]$/.test(data.level) &&
      Number.isInteger(data.estimatedAnswerSeconds) &&
      data.estimatedAnswerSeconds<=30 &&
      sources.length>=MIN_SOURCES && domains>=2 &&
      data.sourceAgreement===true;

    if(!ready) return error(res,"NO_QUALIFIED_QUESTION",
      "Der kunne ikke genereres et tilstrækkeligt dokumenteret Joker-spørgsmål.",409);

    const questionId="JOKER-"+crypto.randomUUID();
    p.jokerUsed=true;
    return res.json({
      status:"READY",turnId,questionId,categoryId,topic,
      question:data.question,answer:data.answer,level:data.level,
      maxAnswerTimeSeconds:30,
      estimatedAnswerSeconds:data.estimatedAnswerSeconds,
      sources:sources.slice(0,MAX_SOURCES),
      sourceQuality:data.sourceQuality
    });
  } catch(e) {
    console.error(e);
    return error(res,"GENERATOR_UNAVAILABLE","Joker-generatoren er midlertidigt utilgængelig.",503);
  }
});

app.listen(PORT,()=>console.log(`UBI ES v1.0 backend listening on ${PORT}`));
