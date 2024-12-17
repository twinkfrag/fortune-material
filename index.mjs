import puppeteer from "puppeteer";
import http from "http";
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';

const PORT = 3000;

// SQLiteデータベースの初期化
const db = await open({
  filename: 'dumps/dumps.sqlite3',
  driver: sqlite3.Database
});

// テーブルの作成
await db.exec(`
  CREATE TABLE IF NOT EXISTS sites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    baseUrl TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS dumps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    siteId INTEGER,
    requestUrl TEXT,
    headers TEXT,
    body BLOB,
    status INTEGER,
    charset TEXT,
    FOREIGN KEY (siteId) REFERENCES sites(id),
    UNIQUE(siteId, requestUrl)
  );
`);

const browser = await puppeteer.launch({
  headless: false,
  args: ["--no-sandbox", "--disable-setuid-sandbox"],
  defaultViewport: null,
});
browser.on('disconnected', () => {
  server?.close();
  db?.close();
});
const page = (await browser.pages())[0];
// キャッシュを無効化
await page.setCacheEnabled(false);



// HTTPサーバーを作成してURLごとの挙動を定義
const server = http.createServer(async (req, res) => {

  // ルートURLの場合はrootHTMLを返す
  if (req.url === "/") {
    // ダンプ済みのサイトからrootHTMLを作成
    const sitesRows = await db.all('SELECT * FROM sites');
    const rootHtml = `
<html>
  <body>
    <form action="/dump" method="post">
      <input type="text" name="url" placeholder="URL">
      <button type="submit">Dump</button>
    </form>
    <h1>Available Dumps</h1>
    <ul>
      ${sitesRows.map(row => {
      // タイムスタンプを日本時間に変換
      const timestamp = new Date(row.timestamp);
      const options = {
        timeZone: 'Asia/Tokyo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
      };
      const jstTimestamp = new Intl.DateTimeFormat('ja-JP', options).format(timestamp);

      return `<li>${row.id}: <a href="/show/${row.id}">${row.baseUrl}</a> - ${jstTimestamp}</li>`;
    }).join('')}
    </ul>
  </body>
</html>
`;
    page.setRequestInterception(false);
    page.off("request");
    page.off("response");

    res.writeHead(200, {
      'Content-Type': 'text/html',
      'Cache-Control': 'no-cache, no-store, must-revalidate', // キャッシュ無効化
      'Pragma': 'no-cache',
      'Expires': '0'
    });
    res.end(rootHtml);
    return;
  }

  // dumpボタンが押された場合
  else if (req.url === "/dump") {
    const newPage = await browser.newPage();


    let body = '';
    req.on('data', chunk => {
      body += chunk.toString();
    });
    req.on('end', async () => {
      const url = new URLSearchParams(body).get('url');
      const baseUrl = new URL(url);
      const isoDate = new Date().toISOString();

      // サイト情報を挿入または更新
      await db.run(`
        INSERT INTO sites (baseUrl, timestamp)
        VALUES (?, ?)
      `, [baseUrl.href, isoDate]);

      // サイトIDを取得
      const newSiteRow = await db.get(`
        SELECT id FROM sites WHERE baseUrl = ? AND timestamp = ?
      `, [baseUrl.href, isoDate]);

      const siteId = newSiteRow.id;

      // イベントリスナーをクリア
      newPage.setRequestInterception(false);
      newPage.off("request");
      newPage.off("response");

      newPage.on("response", async (response) => {
        const requestUrl = response.url();
        const headers = JSON.stringify(response.headers());
        const status = response.status();

        let body = Buffer.from('');
        let charset = '';

        try {
          if (!response.ok()) {
            console.log(`dump(${siteId}): Non-OK response: ${response.status()} for ${response.url()}`);
          }
          else if (response.request().method() === 'OPTIONS') {
            console.log(`dump(${siteId}): Skipping preflight request: ${response.url()}`);
          }
          else {
            body = await response.buffer();

            // レスポンスヘッダーからcharsetを抽出
            const contentType = response.headers()['content-type'];
            if (contentType) {
              const charsetMatch = contentType.match(/charset=([^;]+)/i);
              if (charsetMatch) {
                charset = charsetMatch[1];
              }
            }
            // HTML内の<meta>タグからcharsetを抽出
            if (!charset && contentType.includes('text/html')) {
              const html = body.toString();
              const metaCharsetTag = html.match(/<meta\s+charset=["']?([^"']+)["']?/i);
              const metaContentTypeTag = html.match(/<meta\s+http-equiv=["']Content-Type["']\s+content=["']text\/html;\s*charset=([^"']+)["']?/i);
              if (metaCharsetTag) {
                charset = metaCharsetTag[1];
              } else if (metaContentTypeTag) {
                charset = metaContentTypeTag[1];
              }
            }
          }
        } catch (e) {
          console.error(`dump(${siteId}): Error processing response for ${response.url()}: ${e.message}`);
        }

        await db.run(`
          INSERT OR REPLACE INTO dumps (id, siteId, requestUrl, headers, body, status, charset)
          VALUES (
            (SELECT id FROM dumps WHERE siteId = ? AND requestUrl = ?),
            ?, ?, ?, ?, ?, ?
          )
        `, [siteId, requestUrl, siteId, requestUrl, headers, body, status, charset]);

        console.log(`dump(${siteId}): Saved(${status}): ${requestUrl}`);
      });

      await newPage.goto(baseUrl.href);

      res.writeHead(302, { 'Location': '/' });
      res.end();
    });
  }

  // ダンプ済みのサイトを表示する場合
  else if (req.url.startsWith("/show/")) {
    const siteId = req.url.split("/")[2];

    const newPage = await browser.newPage();

    const sitesRow = await db.get('SELECT * FROM sites WHERE id = ?', [siteId]);
    const baseUrl = new URL(sitesRow.baseUrl);
    const dumpsRows = await db.all('SELECT * FROM dumps WHERE siteId = ?', [siteId]);

    newPage.off("request");
    newPage.off("response");
    newPage.setRequestInterception(true);

    newPage.on("request", async (interceptedRequest) => {
      const requestUrl = interceptedRequest.url();
      if (interceptedRequest.method() === "OPTIONS") {
        console.log(`show(${siteId}): Skipping preflight request: ${interceptedRequest.url()}`);
        interceptedRequest.continue();
        return;
      }

      const dump = dumpsRows.find(row => row.requestUrl === requestUrl);

      if (!dump) {
        console.log(`show(${siteId}): Not found: ${requestUrl}`);
        await interceptedRequest.respond({
          status: 404,
          headers: {
            'Content-Type': 'text/plain'
          },
          body: 'Not found'
        });
        return;
      }

      // ヘッダーの改行を削除
      const headers = Object.fromEntries(
        Object.entries(JSON.parse(dump.headers)).map(([key, value]) => [key, value.replace(/\r?\n|\r/g, '')])
      );

      if (dump.charset != null && !headers['content-type']?.includes('charset')) {
        headers['content-type'] = `${headers['content-type']}; charset=${dump.charset}`;
      }

      await interceptedRequest.respond({
        status: dump.status,
        headers: headers,
        body: dump.body || null,
      });
      console.log(`show(${siteId}): Responded(${dump.status}): ${requestUrl}`);
    });

    await newPage.goto(baseUrl.href);
    res.writeHead(302, { 'Location': '/' });
    res.end();
  }
});

server.listen(PORT, async () => {
  await page.goto(`http://localhost:${PORT}/`);
});
