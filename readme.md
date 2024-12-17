# Fortune Material
ローカルで魚拓とるやつ。

## 概要
puppeteerを使用して、アクセスしたページのレスポンスをそのまま保存する。  
閲覧時には、puppeteer上のリクエストをDB内の魚拓で上書きしてレスポンスを返す。

## usage
`node index.mjs`

puppeteerをインストールしていない場合、
> npx puppeteer browsers install chrome
コマンドを実行する必要がある。

## using
- puppeteer
- sqlite3

## license
The MIT License.
