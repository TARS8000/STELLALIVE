# StellaLive

空を見上げると、今見える人工衛星の名前と方向が分かる静的サイトです。GitHub Pages 上でバックエンドなしで動きます。

- 軌道要素: [CelesTrak](https://celestrak.org/NORAD/elements/) の GP（JSON）
- 位置計算: [satellite.js](https://github.com/shashwatak/satellite-js)（SGP4）
- 表示: 端末の位置情報 + カメラ + デバイス向き（AR）。PC では全天マップ

## GitHub Pages への載せ方

1. このリポジトリを GitHub に push する
2. **Settings → Pages → Build and deployment**
3. Source を **Deploy from a branch**、Branch を `main` / `/ (root)` にする
4. 公開 URL（`https://<user>.github.io/Stellalive/` など）を **スマホのブラウザ（HTTPS）** で開く

位置情報・カメラ・向きセンサーは HTTPS が必要です。GitHub Pages はそのまま使えます。

## 使い方

1. **空を見る** をタップし、位置情報・カメラ・（iPhone なら）モーションを許可する
2. 屋外で空にカメラを向ける
3. 明るい点の横に衛星名と仰角が出る。右下は地平線より上の一覧
4. カタログは「明るい衛星」「宇宙ステーション」「GPS」などを切り替え可能

方位は磁気北ベースのため、真北とは数度ずれることがあります。校正のため、端末を 8 の字に振ると安定しやすいです。

## ローカル確認

```bash
npx --yes serve -p 4173
```

`http://localhost:4173` を開きます。カメラやセンサーの確認は実機の HTTPS が確実です。
