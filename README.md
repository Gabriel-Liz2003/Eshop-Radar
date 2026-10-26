# eShop BR Alert

PWA/Worker gratuito para monitorar **todos os jogos que entram em promoção na Nintendo eShop Brasil**, com alertas Web Push no Android.

## Recursos

- monitora o catálogo brasileiro de promoções da Nintendo;
- Cloudflare Worker + D1 + Queues, pensado para o plano Free;
- PWA instalável no Android;
- Web Push direto, sem Discord, Telegram ou ntfy;
- alertas individuais para 1–3 jogos e agrupados para lotes maiores;
- Wishlist/prioridade para receber alerta individual mesmo dentro de um lote;
- histórico de novas promoções no painel;
- proteção contra notificações duplicadas;
- **verificação de atualizações dentro do app via GitHub**.

## Versão atual

**v1.7.0**

O arquivo [`version.json`](./version.json) é a fonte pública usada pelo próprio app para descobrir atualizações.

## Atualizar uma instalação existente

Baixe o ZIP da versão mais recente em **Releases**, extraia sobre a pasta do projeto e faça somente o deploy:

```bash
proot-distro login ubuntu --shared-home
cd ~/eshop-br-alert
./node_modules/.bin/wrangler deploy
```

Em atualizações normais **não rode novamente** `npm run setup`, `npm run upgrade-push` ou `npm run upgrade-queue`, salvo quando as notas da versão disserem explicitamente o contrário.

## Instalação nova pelo Android/Termux

O projeto foi pensado para também poder ser implantado pelo celular. O Wrangler deve rodar dentro de Ubuntu via `proot-distro`, porque o binário não suporta Android/Bionic diretamente.

Resumo:

```bash
# Termux
pkg install -y proot-distro
proot-distro install ubuntu
proot-distro login ubuntu --shared-home

# Ubuntu
apt update
apt install -y nodejs npm curl unzip
cd ~/eshop-br-alert
npm install
npm run setup
```

Depois siga a saída do setup para autenticar a Cloudflare, configurar o Worker/D1 e abrir o painel privado.

## Verificação de atualizações

No painel/PWA existe a seção **Atualizações**.

- mostra a versão instalada;
- consulta `version.json` neste repositório;
- verifica automaticamente no máximo uma vez a cada 6 horas por aparelho;
- permite verificação manual a qualquer momento;
- quando há versão nova, mostra as notas e o botão para baixar o ZIP oficial da Release.

A verificação **não faz deploy automaticamente** e não precisa de token do GitHub.

## Arquitetura

```text
Nintendo eShop BR / Algolia
          ↓
Cloudflare Cron (1 min)
          ↓
Cloudflare Queue
          ↓
Worker → D1
          ↓
novas promoções
          ↓
Web Push → PWA Android
```

## Segurança

Não publique credenciais no repositório. Os arquivos locais abaixo já estão ignorados pelo Git:

- `.eshop-setup.json`
- `.dev.vars`
- `.wrangler/`
- `node_modules/`

Os secrets como `ADMIN_TOKEN`, `VAPID_PRIVATE_KEY` e bindings/configurações privadas ficam na Cloudflare, não no código.

## Desenvolvimento

```bash
npm install
npm run typecheck
npm run dev
```

## Releases

O workflow `.github/workflows/release.yml` cria automaticamente uma GitHub Release e o arquivo `eshop-br-alert-android.zip` quando uma tag `v*` é enviada.

Antes de criar uma nova tag:

1. atualize `APP_VERSION` em `src/index.ts`;
2. atualize `package.json`;
3. atualize `version.json` e `CHANGELOG.md`;
4. confirme `npm run typecheck`;
5. crie a tag, por exemplo `v1.7.1`.