import fs from 'node:fs';
import { layerOf, projectFiles } from '../codescanner.js';
import { cut } from '../util.js';

/*
 * Static map of a project (any language): where it calls other services, where it
 * receives webhooks, where it puts work on a queue / emits events, and where
 * workers / listeners pick it up. Pattern based, so treat it as a pointer list.
 */
const RULES = {
  http: [
    ['Laravel Http', /\bHttp::(get|post|put|patch|delete|send|withToken|withHeaders|withBasicAuth|acceptJson|asForm|asJson|timeout|retry|baseUrl|pool)\b/],
    ['Guzzle', /new\s+(\\?GuzzleHttp\\)?Client\s*\(|->(request|requestAsync|getAsync|postAsync)\s*\(\s*['"](GET|POST|PUT|PATCH|DELETE)/i],
    ['cURL', /\bcurl_(init|exec|setopt)\s*\(/],
    ['Symfony HttpClient', /HttpClient::create|->request\(\s*['"](GET|POST|PUT|PATCH|DELETE)['"]/],
    ['file_get_contents URL', /file_get_contents\(\s*['"]https?:/],
    ['fetch', /(^|[^\w.])fetch\s*\(\s*[`'"\w]/],
    ['axios', /\baxios(\.(get|post|put|patch|delete|request|create))?\s*\(/],
    ['got / ky / superagent', /\b(got|ky|superagent|needle)(\.(get|post|put|patch|delete))?\s*\(/],
    ['Node http', /\bhttps?\.(get|request)\s*\(/],
    ['Python requests/httpx', /\b(requests|httpx|session)\.(get|post|put|patch|delete|request)\s*\(|aiohttp\.ClientSession|urllib\.request\.urlopen/],
    ['Go net/http', /\bhttp\.(Get|Post|PostForm|NewRequest(WithContext)?)\s*\(|client\.Do\(/],
    ['Java HTTP', /\b(RestTemplate|WebClient|HttpClient\.new|OkHttpClient|FeignClient|RestClient)\b/],
    ['.NET HttpClient', /\.(GetAsync|PostAsync|PutAsync|DeleteAsync|SendAsync|GetFromJsonAsync|PostAsJsonAsync)\s*\(/],
    ['Ruby HTTP', /\b(Net::HTTP|Faraday|HTTParty|RestClient)\b/],
    ['SDK client', /new\s+(Stripe|Twilio|S3Client|SESClient|SNSClient|SQSClient|OpenAI|Anthropic|Mailgun|Pusher|Firebase\w*)\b|\\(Stripe|Twilio)\\/],
  ],
  webhook: [
    ['Webhook route', /(route|router|app|Route::\w+|@(Post|Get|Request)Mapping|path|url)\b.{0,60}['"`][^'"`]*(webhook|callback|ipn|notify|hooks?)[^'"`]*['"`]/i],
    ['Webhook handler', /\b(class|function|def|func)\s+\w*(Webhook|Callback|Ipn)\w*/i],
    ['Signature check', /\b(verifySignature|constructEvent|webhookSecret|X-Hub-Signature|Stripe-Signature|hmac)\b/i],
  ],
  produce: [
    ['dispatch', /(::|->|\b)dispatch(Sync|Now|AfterResponse)?\s*\(|\bBus::(dispatch|chain|batch)|\bdispatch\(\s*new\b/],
    ['Queue push', /\bQueue::(push|later|bulk)|->onQueue\(|->delay\(/],
    ['event', /\bevent\(\s*new\s|\bEvent::dispatch|->fire\(|eventDispatcher->dispatch/],
    ['Celery / RQ', /\.(delay|apply_async|send_task)\s*\(|\bq\.enqueue\(|\bqueue\.enqueue\(/],
    ['ActiveJob / Sidekiq', /\.(perform_later|perform_async|perform_in|perform_at|deliver_later)\b/],
    ['BullMQ / Bee', /\b\w*[qQ]ueue\.(add|addBulk)\s*\(|\bnew\s+Queue\s*\(|\.add\(\s*['"`][\w:.-]+['"`]\s*,\s*\{/],
    ['Message bus', /\b(sendToQueue|publish|produce|sendMessage|SendMessageCommand|PublishCommand|basic_publish|xadd|lpush|rpush)\s*\(/i],
    ['Kafka producer', /\bproducer\.(send|sendBatch)\s*\(|KafkaTemplate/],
    ['Emitter', /\.emit\(\s*['"`][\w:.-]+['"`]/],
  ],
  consume: [
    ['Queued job / listener class', /\bimplements\s+.*ShouldQueue|\bclass\s+\w+(Job|Listener|Subscriber|Consumer|Worker|Handler|Processor)\b/],
    ['Listener registration', /\bEvent::listen\(|protected\s+\$listen\s*=|->listen\(|@(EventListener|KafkaListener|RabbitListener|SqsListener|JmsListener|Subscribe|OnEvent|Process|Processor|MessagePattern|EventPattern)\b/],
    ['BullMQ worker', /\bnew\s+Worker\s*\(|\.process\s*\(\s*(['"`][\w-]+['"`]\s*,\s*)?(async\s*)?\(?\w*\)?\s*=>/],
    ['Celery / RQ worker', /@(shared_task|app\.task|celery\.task|job)\b|\bWorker\(\s*\[/],
    ['ActiveJob / Sidekiq', /<\s*(ApplicationJob|ActiveJob::Base)|include\s+Sidekiq::(Worker|Job)|\bdef\s+perform\b/],
    ['Consumer', /\.(consume|subscribe|basic_consume|onMessage|receiveMessage|ReceiveMessageCommand|xreadgroup|blpop|brpop)\s*\(/i],
    ['Event handler', /\.(on|once|addListener)\(\s*['"`](?!click|change|submit|input|keyup|keydown|load|ready|resize|scroll|mouse\w*|focus|blur|error|close|end|data|open|message$)[\w:.-]+['"`]/],
    ['Scheduler / cron', /->(everyMinute|everyFiveMinutes|hourly|daily|weekly|monthly|cron)\(|@Scheduled|cron\.schedule|schedule\.every|node-cron|crontab/],
  ],
};

export function codeMap(folders, kinds = ['http', 'webhook', 'produce', 'consume'], perKind = 400) {
  const files = projectFiles(folders);
  const out = Object.fromEntries(kinds.map((k) => [k, []]));
  for (const { file, rel } of files) {
    let src;
    try { src = fs.readFileSync(file, 'utf8'); } catch { continue; }
    if (src.length > 1_500_000) continue;
    const lines = src.split(/\r?\n/);
    const layer = layerOf(rel);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 500) continue;
      const trimmed = line.trim();
      if (!trimmed || /^(\/\/|#|\*|\/\*|--)/.test(trimmed)) continue; // comments
      for (const kind of kinds) {
        if (out[kind].length >= perKind) continue;
        for (const [label, re] of RULES[kind]) {
          if (re.test(line)) {
            const url = (/(https?:\/\/[^\s'"`)<>]+)/.exec(line) || [])[1] || '';
            out[kind].push({ file: rel, line: i + 1, code: cut(trimmed, 200), label, layer, url });
            break;
          }
        }
      }
    }
  }
  // Tests, seeders and factories last
  const weight = (h) => (['test', 'seeder', 'factory', 'migration'].includes(h.layer) ? 1 : 0);
  for (const k of kinds) out[k].sort((a, b) => weight(a) - weight(b) || a.file.localeCompare(b.file) || a.line - b.line);
  return { files_scanned: files.length, ...out };
}
