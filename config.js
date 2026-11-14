// Configuração do painel. Nada aqui é segredo: o client ID do OAuth é público por desenho.
window.PAINEL_CONFIG = {
  CLIENT_ID: '213267316733-827thqvdu64nae2bkdrsaopvkffl776t.apps.googleusercontent.com', // ID do cliente OAuth (Google Cloud > Credenciais). O Felipe cola aqui.
  PROJECT_ID: 'my-first-project-237704', // literal-ok: página estática não importa o _shared/bq.py (PROJECT); os .sql não repetem, o job roda neste projeto
  TENANT: 'fred', // cliente padrão do seletor; ?tenant= na URL vence
  CHECKIN_URL: 'https://n8n.srv1732310.hstgr.cloud/webhook/crm-checkin', // literal-ok: página estática não importa o _shared/recursos.py; webhook público, quem manda é o token do Google conferido no servidor
  SETUP_URL: 'https://n8n.srv1732310.hstgr.cloud/webhook/setup-anotar', // literal-ok: página estática não importa o _shared/recursos.py; webhook público, quem manda é o token do Google conferido no servidor (só o e-mail do Felipe grava)
  VERSION: 'df106128b3', // o versionar.sh (chamado pelo publicar.sh) troca por um hash do conteúdo: o Pages guarda 10 min, então sql/ e fixtures/ pedem ?v=VERSION
  LOCATION: 'US', // location real do dataset analytics (bigquery.Client.get_dataset, 04/10/2026)
};
