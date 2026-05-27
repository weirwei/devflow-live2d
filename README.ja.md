# devflow-live2d

**言語:** [English](README.md) | [简体中文](README.zh-CN.md) | 日本語

![Devflow Live2D desktop overlay demo](docs/demo.png)

`devflow-live2d` は Devflow 向けの macOS Live2D デスクトップオーバーレイクライアントです。Tauri 上で動作し、`devflow-protocol` の実行イベントをアバターの状態、モーション、表情、吹き出しに変換します。

## 機能

- macOS デスクトップオーバーレイとトレイメニュー
- Live2D 公式ランタイムのアダプターとフォールバック描画
- 複数モデル対応。現在は `nito-runtime` モデルセットを同梱
- プロトコルイベントからモーション、表情、ムード、吹き出し表示へのマッピング
- Codex bridge：`~/.codex/sessions/**/rollout-*.jsonl` を読み取り、ローカルプロトコルサービスへ転送
- Claude グローバル `devflow-protocol` プラグインのインストール/アンインストール
- 任意の AI 雑談セリフ生成。API key はメインプロセス側に保持

## スコープ

このリポジトリが担当するのはデスクトップクライアントと Live2D 表示レイヤーです。以下は対象外です。

- Claude/Codex の生イベント解析
- 共有プロトコルの保存、取り込み、サービス実装
- pixel-office のキャラクターおよびワールドロジック

## 必要環境

- macOS
- Node.js と npm
- Codex bridge 用の `python3`
- パッケージ作成時には隣接ディレクトリ `../devflow-protocol-go` が必要です。そこに `bin/devflow-protocol` と `claude-plugin/` が存在している必要があります。

## インストールと開発

```bash
npm install
npm run dev
```

よく使うスクリプト：

```bash
npm run doctor
npm test
npm run dist:mac
```

- `npm run doctor` は Live2D manifest、adapter、デフォルトモデル JSON、公式ランタイムリソースを検証します。
- `npm test` は主要 JavaScript ファイルの構文を確認し、Bun のテストを実行します。
- `npm run dist:mac` は同梱プロトコルリソースを準備してから、Tauri で macOS アプリ成果物を生成します。

## ローカルプロトコルサービス

プロトコルサービスのリポジトリ：[weirwei/devflow-protocol-go](https://github.com/weirwei/devflow-protocol-go)

デフォルトのプロトコル URL は次の通りです。

```text
http://127.0.0.1:4317
```

環境変数で上書きできます。

```bash
DEVFLOW_PROTOCOL_URL=http://127.0.0.1:4317 npm run dev
```

パッケージ済みアプリは、アプリリソース内の `devflow-protocol-go` を起動します。トレイメニューから Codex bridge の開始と停止ができます。bridge は保存済みの読み取り位置から新しい Codex rollout アクティビティを監視し、起動時に直近の履歴を再生しません。

## パッケージ作成

```bash
npm install
npm run dist:mac
```

事前に `scripts/prepare-bundle-resources.mjs` が実行され、隣接リポジトリ `../devflow-protocol-go` からプロトコルバイナリと `claude-plugin` を次の場所へコピーします。

```text
build-resources/bundle/devflow-protocol-go
```

プロトコルリポジトリやビルド成果物が不足している場合、パッケージ作成は失敗します。先に `devflow-protocol-go` 側で `bin/devflow-protocol` をビルドしてください。

## AI 雑談設定

設定ファイル：

```text
~/.devflow/live2d/config.json
```

例：

```json
{
  "personaDialogue": {
    "enabled": true,
    "apiKey": "YOUR_API_KEY",
    "model": "gpt-5-mini",
    "apiUrl": "https://api.openai.com/v1/chat/completions",
    "timeoutMs": 8000
  }
}
```

環境変数からデフォルト値を渡すこともできます。

```bash
DEVFLOW_DIALOGUE_API_KEY=YOUR_API_KEY \
DEVFLOW_DIALOGUE_MODEL=gpt-5-mini \
npm run dev
```

関連する環境変数：

- `DEVFLOW_DIALOGUE_API_KEY`
- `DEVFLOW_DIALOGUE_API_URL`
- `DEVFLOW_DIALOGUE_MODEL`
- `DEVFLOW_DIALOGUE_TIMEOUT_MS`

トレイメニューの `AI 闲聊` は同じ設定ファイルを読み書きします。API key は renderer には公開されません。

## Live2D モデル

モデル設定の入口は `src/live2d-model-catalog.js` の `LIVE2D_MODEL_CONFIG_PATHS` です。同梱モデルは次のディレクトリにあります。

```text
assets/live2d/models/nito-runtime/
```

同梱している `nito-runtime` モデルセットは、Live2D Creative Studio 公式の Nito サンプルモデルを元にしています。

- 出典：[にと | WORKS | Live2D Creative Studio](https://www.live2dcs.jp/works/nito/)
- 制作者：Live2D inc.

各 `*.live2d.json` では以下を設定できます。

- デフォルトのモーション、表情、ムード、保持時間
- `request.created`、`assistant.message`、`tool.started` などのプロトコルイベント動作
- `connected`、`disconnect`、`error` などのローカルランタイム状態動作
- モデルのレイアウト、ランタイムリソースパス、インタラクションメタデータ

モデルやモーショングループを変更した後は、次を実行してください。

```bash
npm run doctor
npm test
```

## ディレクトリ構成

```text
.
  src-tauri/                      Tauri シェル、トレイメニュー、アプリ状態、サービス制御
  ui/                             デスクトップオーバーレイ画面
  src/app/                        アプリ状態とローカルサービスランタイム
  src/dialogue/                   吹き出しと AI 雑談ロジック
  src/avatar/                     アバター状態と割り込みポリシー
  src/event-mapping/              プロトコルイベントの正規化
  assets/live2d/                  Live2D manifest、adapter、モデルリソース
  scripts/                        パッケージ準備、リソース検証、SDK インポート
  tests/                          動作マッピングと会話ロジックのテスト
```
