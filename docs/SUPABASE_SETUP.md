# Ativar o Supabase da Águia Repair

Este repositório já contém a estrutura do banco, as regras de acesso, as funções seguras e os fluxos de implantação. O serviço só fica ativo depois que a loja cria um projeto Supabase e configura as variáveis no GitHub. Nenhum segredo deve ser enviado por mensagem ou salvo neste repositório.

## 1. Criar o projeto

1. Acesse [supabase.com/dashboard](https://supabase.com/dashboard) e entre na conta da loja.
2. Crie uma organização e um projeto chamado **Aguia Repair**. Guarde a senha do banco em um gerenciador de senhas.
3. No projeto, abra **Project Settings → API**. Copie a **Project URL**, a chave **publishable** e o **Project Reference**. A chave publishable pode ser usada no site público; não copie uma chave `secret` ou `service_role` para o navegador.

## 2. Ajustar autenticação e e-mails

Em **Authentication → URL Configuration**:

- Configure **Site URL** como `https://aguiarepair.com.br`.
- Inclua `https://aguiarepair.com.br/funcionario.html` na lista de URLs de redirecionamento permitidas.

Em **Authentication → Sign In / Providers → Email**, mantenha o provedor de e-mail ligado e desative a criação pública de usuários. A loja cria o primeiro administrador e os demais funcionários recebem convite da administração. Clientes não usam login.

Configure um provedor SMTP próprio antes de convidar a equipe para produção. O envio padrão do Supabase é limitado e serve para avaliação; convites dependem da entrega de e-mail. Consulte [as orientações de SMTP do Supabase](https://supabase.com/docs/guides/auth/auth-smtp).

## 3. Guardar as configurações no GitHub

No repositório `andrewillia65/Aguia-Repair`, abra **Settings → Secrets and variables → Actions**.

Em **Variables**, crie:

| Nome | Valor |
| --- | --- |
| `SUPABASE_URL` | Project URL copiada no Supabase |
| `SUPABASE_PUBLISHABLE_KEY` | Chave publishable copiada no Supabase |
| `SUPABASE_PROJECT_ID` | Project Reference copiado no Supabase |

Em **Secrets**, crie:

| Nome | Valor |
| --- | --- |
| `SUPABASE_ACCESS_TOKEN` | Token pessoal criado em Supabase → Account → Access Tokens |
| `SUPABASE_DB_PASSWORD` | Senha do banco definida ao criar o projeto |
| `DEVICE_SECRET_ENCRYPTION_KEY` | Chave aleatória base64 de 32 bytes, criada no passo abaixo |
| `LOOKUP_RATE_LIMIT_SALT` | Outra chave aleatória independente, criada no passo abaixo |

Para gerar as duas últimas chaves no PowerShell do Windows, rode este bloco no seu computador e copie cada valor diretamente para o Secret correspondente no GitHub. Não envie os valores por chat, e-mail ou commit:

```powershell
$rng = [Security.Cryptography.RandomNumberGenerator]::Create()
foreach ($name in @('DEVICE_SECRET_ENCRYPTION_KEY', 'LOOKUP_RATE_LIMIT_SALT')) {
  $bytes = New-Object byte[] 32
  $rng.GetBytes($bytes)
  Write-Output "$name=$([Convert]::ToBase64String($bytes))"
}
$rng.Dispose()
```

O token de acesso do Supabase e a senha do banco ficam somente como Secrets do GitHub Actions. As Edge Functions usam as chaves privadas fornecidas pelo próprio ambiente Supabase; elas nunca são publicadas no site.

## 4. Publicar o esquema e as funções

Depois de salvar as variáveis e secrets:

1. No GitHub, abra **Actions → Deploy Supabase backend → Run workflow** e execute na branch `main`.
2. Aguarde a execução verde. Ela aplica as migrações e publica as Edge Functions.
3. A execução **Deploy Jekyll with GitHub Pages dependencies preinstalled** também precisa terminar verde para publicar a configuração pública e habilitar o catálogo e as consultas.

O fluxo de implantação só executa o backend quando `SUPABASE_PROJECT_ID` está preenchido. Nos próximos commits que alterarem `supabase/`, a implantação do backend é iniciada automaticamente.

## 5. Criar o primeiro administrador

Depois da primeira migração:

1. No Supabase, abra **Authentication → Users → Add user** e crie a conta do administrador com o e-mail da loja.
2. Copie o UUID desse usuário.
3. Abra **SQL Editor → New query** e execute, trocando os dois valores de exemplo pelos dados reais da loja:

```sql
insert into public.staff_profiles (user_id, display_name, role, active)
values ('UUID_DO_USUARIO', 'NOME_DO_ADMINISTRADOR', 'admin', true);
```

O UUID e o nome são dados da equipe, portanto devem ser inseridos diretamente no painel privado do Supabase, nunca no código público. Depois, o administrador entra em `https://aguiarepair.com.br/funcionario.html` e pode convidar técnicos e funcionários pela tela **Equipe**.

## Segurança aplicada

- Visitantes consultam somente produtos publicados e OS/garantias com o número da OS e o código entregue pela loja.
- O navegador não recebe credenciais de banco privilegiadas, PIN/senha do aparelho, observações internas, dados financeiros nem estoque interno.
- PIN/senha opcional do aparelho é cifrado no servidor, protegido por função e permissão da equipe e não aparece na consulta pública.
- Funcionários enviam orçamentos pela área restrita; o cliente aprova ou recusa na consulta protegida pelo código da OS, sem conta.
- As sessões da equipe ficam apenas na memória da página; ao atualizar, a pessoa entra novamente.
- Cadastros de clientes não criam contas de autenticação.

Antes de usar com dados reais, confirme no painel Supabase o domínio de e-mail remetente, URLs permitidas, SMTP e que o convite de funcionário chega à página de definição de senha.
