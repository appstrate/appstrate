Vapi places an outbound phone call: a voice assistant defined in the request asks
the callee a question, then Vapi extracts the answer as JSON. Base URL:
`https://api.vapi.ai`.

#### 1. Pick the caller number

`GET /phone-number` returns an array of numbers (`id`, `number`, `provider`,
`status`).

- Exactly one: use its `id`.
- Several: use the `id` named in your prompt or input. None named: stop and ask
  for it.
- None: stop and report that a phone number must be imported in Vapi first.

#### 2. Place the call

`POST /call` with the number's `id` as `phoneNumberId`, the callee's number in
E.164 as `customer.number`, and a transient `assistant`. Example for a French
callee:

```json
{
  "phoneNumberId": "<id from GET /phone-number>",
  "customer": { "number": "+33612345678" },
  "assistant": {
    "firstMessage": "Bonjour, je suis l'assistant vocal automatique de <organisation>. Cet appel est enregistré. Je vous appelle pour <objet>.",
    "model": {
      "provider": "openai",
      "model": "gpt-4.1-mini",
      "messages": [
        {
          "role": "system",
          "content": "Tu es un assistant vocal qui appelle au nom de <organisation>. Pose une seule question : <question>. Reformule la réponse pour la confirmer, remercie, puis raccroche. Si on te le demande, dis que tu es une IA. Ne promets rien."
        }
      ],
      "tools": [{ "type": "endCall" }]
    },
    "voice": { "provider": "azure", "voiceId": "fr-FR-DeniseNeural" },
    "transcriber": { "provider": "deepgram", "model": "nova-2", "language": "fr" },
    "maxDurationSeconds": 180,
    "artifactPlan": {
      "structuredOutputs": [
        {
          "name": "availability",
          "description": "The callee's availability for <subject>",
          "schema": {
            "type": "object",
            "properties": {
              "available": { "type": "boolean" },
              "slot": { "type": "string", "description": "Proposed date and time, if any" }
            },
            "required": ["available"]
          }
        }
      ]
    }
  }
}
```

- Always set `maxDurationSeconds` (120 to 180). Vapi's default is 600.
- `artifactPlan.structuredOutputs`: one entry per answer to collect; `name` and
  `schema` are required.
- `tools: [{ "type": "endCall" }]` lets the assistant hang up once it has the
  answer.
- The example's model, voice and transcriber run on Vapi's own provider
  accounts: they need no other key.
- Never send the `phoneNumber` field: it carries provider credentials.

The response is the call. Keep its `id`.

#### 3. Wait for the end

Do not call again right away: run `sleep 25`, then `GET /call/{id}`. Repeat
until `status` is `"ended"`. Then branch on `endedReason`:

- `customer-did-not-answer`, `customer-busy`, `voicemail`: nobody answered.
  Report it and stop polling.
- `assistant-ended-call`, `assistant-ended-call-after-message-spoken`,
  `customer-ended-call`, `silence-timed-out`, `exceeded-max-duration`: the
  callee was reached. Keep polling until `artifact.structuredOutputsLastUpdatedAt`
  is set (extraction finishes a few seconds after the end); give up 2 minutes
  after the end.
- Any other value: the call failed. Report the raw `endedReason` and
  `endedMessage`.

#### 4. Read the answer

- `artifact.structuredOutputs` is an object keyed by output id; each entry is
  `{ "name", "result" }`. Find yours by `name`. `result: null` means the
  extraction failed.
- `artifact.transcript` is the conversation: cite it as evidence.

#### Rules

- Call a number only when your prompt or input asks for that call. Never for
  cold prospecting.
- The first message says that an AI is calling and that the call is recorded.
- Placing a call needs `maxDurationSeconds` + 120 s of run time left.

#### Setup (operator, once)

- The agent manifest's `timeout` must be at least `maxDurationSeconds` + 120 s:
  the 300 s default is too short (platform ceiling: 1800 s).
- Free Vapi numbers are US-only and cannot call abroad. To call French numbers,
  import a Twilio number into Vapi. A French Twilio number needs a regulatory
  bundle (KBIS, SIRET, NAF code, a listed manager's ID), which takes several
  business days. Since October 2024, French operators block calls whose caller
  ID cannot be authenticated: a foreign number presenting as French will likely
  not get through.
