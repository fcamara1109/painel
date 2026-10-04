// Configuração do painel. Nada aqui é segredo: o client ID do OAuth é público por desenho.
window.PAINEL_CONFIG = {
  CLIENT_ID: '213267316733-oucislb4ift1a6l9igqjqsh6qcsm4273.apps.googleusercontent.com', // ID do cliente OAuth (Google Cloud > Credenciais). O Felipe cola aqui.
  PROJECT_ID: 'my-first-project-237704', // literal-ok: mesmo projeto dos .sql
  TENANT: 'fred',
  LOCATION: 'US', // location real do dataset analytics (bigquery.Client.get_dataset, 04/10/2026)
  START_DEFAULT: '2026-05-01',
};
