# APK Android (Trusted Web Activity)

O APK do eShop Radar é um **Trusted Web Activity (TWA)** gerado pelo Bubblewrap. Ele abre o PWA real do Cloudflare Worker em tela cheia, usando o navegador Android como runtime. Isso preserva Service Worker, Web Push e os dados/sessões do navegador.

## Identidade fixa do app

- Package ID: `com.gabrieldeliz.eshopradar`
- Alias da assinatura: `eshopradar`
- SHA-256 do certificado:
  `31:ED:93:D1:40:75:78:1C:02:35:E6:DD:05:77:9F:7F:C9:A2:30:B8:B8:41:5F:16:CF:80:76:49:72:23:FA:A8`

O Worker publica esse fingerprint em:

`/.well-known/assetlinks.json`

Isso é o que permite abrir o site como TWA sem barra de navegador.

## Chave de assinatura

A chave privada **não é pública**. O repositório guarda apenas `release-keystore.jks.enc.b64`, uma cópia criptografada.

Para o workflow de Release gerar um APK atualizável, crie no GitHub:

**Settings → Secrets and variables → Actions → New repository secret**

Nome:

`ANDROID_KEYSTORE_PASSWORD`

O mesmo segredo é usado para descriptografar o keystore e como senha do keystore/chave.

Nunca altere o package ID ou a chave de assinatura depois que o APK for instalado. Android só permite atualizar um app quando pacote e certificado continuam os mesmos.

## Build

O workflow `Android APK` valida o projeto TWA e gera um APK **não assinado** como artefato de CI.

O workflow `Release`, acionado por tags `v*`, descriptografa o keystore usando o secret e publica:

- `Eshop-Radar.apk`
- `Eshop-Radar.aab`
- `eshop-br-alert-source.zip`

O APK é a opção para instalação direta. O AAB fica preparado para uma eventual publicação na Play Store.
