# UBI ES v1.0 – AI/Joker integration

## What is integrated
The backend now uses the OpenAI Responses API with the built-in web search tool for:
1. immediate Joker-topic validation at player connection
2. source-backed Joker question generation when the Joker is used
3. structured JSON output
4. a second validation gate before a question receives READY
5. server-side storage of the approved category + topic
6. source URLs returned with the generated question

OpenAI's current documentation recommends the Responses API for new integrations; the web search tool is supported directly in Responses. See:
- https://platform.openai.com/docs/quickstart/make-your-first-api-request
- https://platform.openai.com/docs/api-reference/responses-streaming/response/refusal
- https://platform.openai.com/docs/models/whisper

## Security
Never put OPENAI_API_KEY in index.html or any browser code. It belongs only in the backend environment.

## Install
npm install

## Configure
Copy `.env.example` to `.env` and set OPENAI_API_KEY.
Use your hosting platform's secret/environment-variable settings in production.

## Start
npm start

## API
POST /api/v1/games/{gameId}/players/{playerId}/joker/validate
POST /api/v1/games/{gameId}/players/{playerId}/joker/use
GET /health

## Important game rule
The client never supplies a new Joker topic at Joker-use time. The backend retrieves the already approved category + topic stored for that player.

## Source policy
A question is READY only if the model returns at least two HTTPS sources from distinct domains and marks source agreement true. The backend also requires an N1-N6 level and an estimated answer time <=30 seconds.

## Current limitation
This package provides the real AI/web-search backend integration, but it still requires deployment of `server.mjs` and an OpenAI API key. GitHub Pages alone cannot execute this server-side secret integration.
