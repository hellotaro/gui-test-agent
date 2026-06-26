# Gui Test Agent
このツールはplaywright mcpのラッパーであり、対話的に自然言語でブラウザ上の操作を指示すると画面上の操作シナリオをAIで生成できる。
生成したシナリオはJSONで保存され、簡単なシナリオ管理機能が含まれる。
また、playwrightによる自動操作でアクセスしたページのDOMはローカルにキャッシュされ、実際にページにアクセスしなくてもキャッシュからシナリオを生成することもできる。
シナリオの実行に失敗した際には自動で修復する機能も備えている。
自動操作後にはツールから次の操作シナリオについて、２，３案の提案を行う。

# 準備
以下ClaudeのAPIキーを環境変数として定義する必要がある。

```
ANTHROPIC_API_KEY=<API KEY>
```

# 実行
以下コマンドにより、対話的コマンド実行環境が立ち上がる。

```
npm start
```

実行できるコマンドは以下である。（上記コマンド実行後にhelpとして表示される）

- auto "<goal>" [url]
    - AIエージェントモード。DOMを見てClaudeで操作シナリオを生成し、そのまま実行する。
- run <scenario> [url]
    - シナリオ実行
- cache list
    - DOMキャッシュ一覧
- cache show <path>
    - DOMキャッシュ内容表示
- cache frames <path>
    - DOMキャッシュ内の iframe 一覧を表示
- gen <path> <name> [--run]
    - DOMからシナリオ生成
- ask "<question>"
    - Claudeに質問
- ask-dom <path> "<question>"
    - DOMを元にClaudeへ質問
- improve <file>
    - シナリオ改善
- scenarios
    - シナリオ一覧
- history
    - 実行済みステップ一覧
- history clear
    - セッション履歴をクリア
- history delete <index>
    - indexで指定されたhistoryを削除
- save-scenario <name>
    - セッション履歴からシナリオ生成
- merge-scenario <file>
    - opsidb.jsonへシナリオをマージ
- help
    - ヘルプ表示
- quit
    - 終了



