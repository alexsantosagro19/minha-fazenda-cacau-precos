-- =====================================================================
-- Minha Fazenda Cacau Pro — banco de dados no Supabase (versão 12.5)
-- Cole tudo no SQL Editor do Supabase e clique em Run. Pode rodar de novo
-- sem problema: o script não apaga nada que já exista. Serve tanto para um
-- projeto novo quanto para atualizar o banco criado nas versões 12.3 e 12.4.
--
-- O que ele cria:
--   perfis        nome, telefone e aceite do termo LGPD de cada produtor (1 por login)
--   assinaturas   situação: aguardando (conta nova, sem plano), ativa, atrasada,
--                 cancelada, cortesia; e o plano (pro ou premium)
--   fazendas      cópia na nuvem de cada fazenda do app (o banco inteiro em JSON)
--   admins        quem administra (você): vê todos os produtores e libera acesso
--   arquivos      depósito privado para fotos e PDFs, uma pasta por produtor
--   cotacoes      preço do cacau e do dólar, um registro por dia (leitura pública)
--   push_inscricoes  celulares que aceitaram o lembrete diário
-- Cada produtor só enxerga e altera o que é dele (Row Level Security).
-- =====================================================================

-- ---------- administradores ----------
create table if not exists public.admins (
  user_id uuid primary key references auth.users(id) on delete cascade,
  criado_em timestamptz not null default now()
);
alter table public.admins enable row level security;

create or replace function public.eh_admin()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.admins where user_id = auth.uid());
$$;

drop policy if exists "admin vê admins" on public.admins;
create policy "admin vê admins" on public.admins for select using (public.eh_admin());

-- ---------- perfis ----------
create table if not exists public.perfis (
  id uuid primary key references auth.users(id) on delete cascade,
  nome text not null default '',
  telefone text not null default '',
  email text not null default '',
  criado_em timestamptz not null default now()
);
alter table public.perfis enable row level security;
-- aceite do termo de proteção de dados (LGPD), gravado na criação da conta
alter table public.perfis add column if not exists lgpd_aceite timestamptz;
alter table public.perfis add column if not exists lgpd_versao text not null default '';
alter table public.perfis add column if not exists aceita_comunicacoes boolean not null default false;

drop policy if exists "produtor vê o próprio perfil" on public.perfis;
create policy "produtor vê o próprio perfil" on public.perfis
  for select using (id = auth.uid() or public.eh_admin());
drop policy if exists "produtor edita o próprio perfil" on public.perfis;
create policy "produtor edita o próprio perfil" on public.perfis
  for update using (id = auth.uid()) with check (id = auth.uid());

-- ---------- assinaturas ----------
create table if not exists public.assinaturas (
  user_id uuid primary key references auth.users(id) on delete cascade,
  status text not null default 'aguardando',
  plano text not null default '',
  teste_ate date,
  pago_ate date,
  asaas_cliente text,
  asaas_assinatura text,
  obs text not null default '',
  atualizado_em timestamptz not null default now()
);
alter table public.assinaturas enable row level security;

-- versão 12.4: sem teste grátis. Conta nova fica "aguardando" até você liberar
-- um plano (Pro ou Premium) ou uma cortesia.
alter table public.assinaturas add column if not exists plano text not null default '';
alter table public.assinaturas drop constraint if exists assinaturas_status_check;
alter table public.assinaturas add constraint assinaturas_status_check
  check (status in ('aguardando','teste','ativa','atrasada','cancelada','cortesia'));
alter table public.assinaturas drop constraint if exists assinaturas_plano_check;
alter table public.assinaturas add constraint assinaturas_plano_check check (plano in ('','pro','premium'));
alter table public.assinaturas alter column status set default 'aguardando';
alter table public.assinaturas alter column teste_ate drop not null;
alter table public.assinaturas alter column teste_ate drop default;
update public.assinaturas set status = 'aguardando' where status = 'teste';

-- o produtor só lê a própria; quem muda é você (admin) ou a cobrança (chave secreta, no servidor)
drop policy if exists "produtor vê a própria assinatura" on public.assinaturas;
create policy "produtor vê a própria assinatura" on public.assinaturas
  for select using (user_id = auth.uid() or public.eh_admin());
drop policy if exists "admin altera assinaturas" on public.assinaturas;
create policy "admin altera assinaturas" on public.assinaturas
  for update using (public.eh_admin()) with check (public.eh_admin());

-- o app pergunta: este login pode usar o app hoje? (tolerância de 10 dias depois do vencimento)
-- "aguardando" e "cancelada" não entram.
create or replace function public.acesso_liberado()
returns boolean language sql stable security definer set search_path = public as $$
  select coalesce((
    select case
      when a.status = 'cortesia' then true
      when a.status in ('ativa','atrasada') then coalesce(a.pago_ate, current_date) + 10 >= current_date
      else false end
    from public.assinaturas a where a.user_id = auth.uid()
  ), false) or public.eh_admin();
$$;

-- ---------- conta nova: perfil e assinatura "aguardando" ----------
create or replace function public.ao_criar_usuario()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into public.perfis (id, nome, telefone, email, lgpd_aceite, lgpd_versao, aceita_comunicacoes)
  values (new.id,
          coalesce(new.raw_user_meta_data->>'nome', ''),
          coalesce(new.raw_user_meta_data->>'telefone', ''),
          coalesce(new.email, ''),
          case when coalesce(new.raw_user_meta_data->>'lgpd_versao', '') <> '' then now() end,
          coalesce(new.raw_user_meta_data->>'lgpd_versao', ''),
          coalesce(new.raw_user_meta_data->>'comunicacoes', '') = 'true')
  on conflict (id) do nothing;
  insert into public.assinaturas (user_id) values (new.id) on conflict (user_id) do nothing;
  return new;
end;
$$;
drop trigger if exists ao_criar_usuario on auth.users;
create trigger ao_criar_usuario after insert on auth.users
  for each row execute function public.ao_criar_usuario();

-- ---------- fazendas (sincronização do app) ----------
create table if not exists public.fazendas (
  id text primary key,                                   -- o mesmo id que a fazenda tem no aparelho
  dono uuid not null default auth.uid() references auth.users(id) on delete cascade,
  nome text not null default '',
  dados jsonb not null default '{}'::jsonb,              -- o banco inteiro da fazenda
  versao bigint not null default 1,                      -- sobe a cada envio; evita apagar o que outro aparelho mandou
  aparelho text not null default '',
  excluida boolean not null default false,
  atualizado_em timestamptz not null default now()
);
create index if not exists fazendas_dono on public.fazendas (dono);
alter table public.fazendas enable row level security;

drop policy if exists "dono lê" on public.fazendas;
create policy "dono lê" on public.fazendas for select using (dono = auth.uid() or public.eh_admin());
drop policy if exists "dono cria" on public.fazendas;
create policy "dono cria" on public.fazendas for insert with check (dono = auth.uid() and public.acesso_liberado());
drop policy if exists "dono altera" on public.fazendas;
create policy "dono altera" on public.fazendas for update
  using (dono = auth.uid()) with check (dono = auth.uid() and public.acesso_liberado());
drop policy if exists "dono apaga" on public.fazendas;
create policy "dono apaga" on public.fazendas for delete using (dono = auth.uid());

create or replace function public.carimbar_fazenda()
returns trigger language plpgsql as $$
begin
  new.atualizado_em := now();
  if tg_op = 'UPDATE' then new.versao := old.versao + 1; new.dono := old.dono; end if;
  return new;
end;
$$;
drop trigger if exists carimbar_fazenda on public.fazendas;
create trigger carimbar_fazenda before insert or update on public.fazendas
  for each row execute function public.carimbar_fazenda();

-- ---------- arquivos (fotos, PDFs, comprovantes): pasta = id do produtor ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('arquivos', 'arquivos', false, 26214400)          -- 25 MB por arquivo, como no app
on conflict (id) do nothing;

drop policy if exists "produtor lê os próprios arquivos" on storage.objects;
create policy "produtor lê os próprios arquivos" on storage.objects for select
  using (bucket_id = 'arquivos' and ((storage.foldername(name))[1] = auth.uid()::text or public.eh_admin()));
drop policy if exists "produtor envia arquivos" on storage.objects;
create policy "produtor envia arquivos" on storage.objects for insert
  with check (bucket_id = 'arquivos' and (storage.foldername(name))[1] = auth.uid()::text and public.acesso_liberado());
drop policy if exists "produtor troca arquivos" on storage.objects;
create policy "produtor troca arquivos" on storage.objects for update
  using (bucket_id = 'arquivos' and (storage.foldername(name))[1] = auth.uid()::text);
drop policy if exists "produtor apaga arquivos" on storage.objects;
create policy "produtor apaga arquivos" on storage.objects for delete
  using (bucket_id = 'arquivos' and (storage.foldername(name))[1] = auth.uid()::text);

-- ---------- cotações do cacau (gravadas pela função "precos"; todos podem ler) ----------
create table if not exists public.cotacoes (
  data date primary key,
  conv numeric,                 -- Bahia convencional, R$/@
  var_conv numeric,
  cert numeric,                 -- Bahia certificado, R$/@
  var_cert numeric,
  ny numeric,                   -- Nova York, US$/t
  ny_contrato text,
  ny_var numeric,
  dolar numeric,                -- R$ por US$
  dolar_var numeric,
  coletado_em timestamptz not null default now()
);
alter table public.cotacoes enable row level security;
drop policy if exists "todos leem cotações" on public.cotacoes;
create policy "todos leem cotações" on public.cotacoes for select using (true);
-- só a função (com a chave secreta, no servidor) grava

-- ---------- lembrete diário no celular (notificação) ----------
create table if not exists public.push_inscricoes (
  endpoint text primary key,                            -- endereço do celular no serviço de notificação
  user_id uuid not null default auth.uid() references auth.users(id) on delete cascade,
  p256dh text not null,
  auth text not null,
  aparelho text not null default '',
  criado_em timestamptz not null default now(),
  ultimo_envio date,
  falhas int not null default 0
);
create index if not exists push_inscricoes_user on public.push_inscricoes (user_id);
alter table public.push_inscricoes enable row level security;
drop policy if exists "produtor vê os próprios lembretes" on public.push_inscricoes;
create policy "produtor vê os próprios lembretes" on public.push_inscricoes
  for select using (user_id = auth.uid() or public.eh_admin());
drop policy if exists "produtor desliga os próprios lembretes" on public.push_inscricoes;
create policy "produtor desliga os próprios lembretes" on public.push_inscricoes
  for delete using (user_id = auth.uid());

-- o app chama esta função ao ativar o lembrete (o mesmo celular pode trocar de conta)
create or replace function public.registrar_push(p_endpoint text, p_p256dh text, p_auth text, p_aparelho text default '')
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sem login'; end if;
  insert into public.push_inscricoes (endpoint, user_id, p256dh, auth, aparelho)
  values (p_endpoint, auth.uid(), p_p256dh, p_auth, left(coalesce(p_aparelho, ''), 120))
  on conflict (endpoint) do update
    set user_id = auth.uid(), p256dh = excluded.p256dh, auth = excluded.auth,
        aparelho = excluded.aparelho, falhas = 0;
end;
$$;
revoke all on function public.registrar_push(text, text, text, text) from public, anon;
grant execute on function public.registrar_push(text, text, text, text) to authenticated;

-- ---------- painel do administrador ----------
create or replace view public.painel_produtores with (security_invoker = true) as
  select p.id, p.nome, p.email, p.telefone, p.criado_em,
         a.status, a.teste_ate, a.pago_ate, a.obs,
         (select count(*) from public.fazendas f where f.dono = p.id and not f.excluida) as fazendas,
         (select max(f.atualizado_em) from public.fazendas f where f.dono = p.id) as ultimo_envio,
         a.plano,
         (select count(*) from public.push_inscricoes s where s.user_id = p.id) as lembretes,
         p.lgpd_aceite, p.lgpd_versao, p.aceita_comunicacoes
  from public.perfis p left join public.assinaturas a on a.user_id = p.id;

-- =====================================================================
-- DEPOIS de criar o SEU login (Authentication › Users › Add user),
-- troque o e-mail abaixo pelo seu, selecione só estas linhas e rode:
--
--   insert into public.admins (user_id)
--   select id from auth.users where email = 'seu-email@exemplo.com'
--   on conflict do nothing;
--
-- O jeito mais fácil de liberar um produtor é pelo próprio app:
-- Dados › Painel do administrador › Plano Pro, Plano Premium ou Cortesia.
-- Se preferir pelo SQL, cortesia (app doado):
--
--   update public.assinaturas set status = 'cortesia', obs = 'app doado'
--   where user_id = (select id from auth.users where email = 'email-do-produtor@exemplo.com');
--
-- Plano Pro pago por um ano:
--
--   update public.assinaturas set status = 'ativa', plano = 'pro', pago_ate = current_date + 365
--   where user_id = (select id from auth.users where email = 'email-do-produtor@exemplo.com');
-- =====================================================================
