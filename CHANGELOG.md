# Changelog

## 1.7.0 — 2026-10-26

- Adiciona **Verificar atualizações** dentro do PWA.
- Faz uma verificação automática no GitHub no máximo uma vez a cada 6 horas por aparelho.
- Mostra versão instalada, versão mais recente, notas e botão de download quando houver atualização.
- Centraliza a versão pública em `version.json` no repositório oficial.
- Adiciona CI e workflow de release para gerar o ZIP oficial a partir de tags `v*`.

## 1.6.6

- Corrige pushes agrupados repetidos com idempotência persistente no D1.
- Persiste histórico e estado antes de efeitos externos de Web Push.
- Usa tags estáveis nas notificações para evitar empilhamento em retries extremos.

## 1.6.x

- Monitoramento de todos os jogos em promoção, sem filtro por franquia.
- Alertas agrupados para lotes grandes e prioridade individual para Wishlist.
- Cloudflare Queues para tirar o scan pesado do Cron do Workers Free.
- Particionamento/paginação do catálogo Algolia e validações de cobertura.

## 1.5.x

- PWA instalável com ícone próprio.
- Pareamento do PWA instalado com sessão separada do navegador.

## 1.4.x

- Web Push direto pelo próprio Worker, removendo a dependência do ntfy.
