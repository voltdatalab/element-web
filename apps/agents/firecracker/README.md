# Workspace Firecracker por agente

Implementação da fatia 2 da [Element Agents #167](https://github.com/fmercurio/claw-tenant/issues/167), vinculada à [frente Firecracker #145](https://github.com/fmercurio/claw-tenant/issues/145).

Pi Durable, a identidade Matrix, as chaves E2EE e as credenciais do modelo continuam no serviço de agentes. O worker do host cria uma microVM por UUID de agente. O guest oferece somente arquivos UTF-8 em `/workspace` e sincronização de disco por vsock. O Pi recebe `write_file`, `read_file` e `restart_machine`, vinculados ao cadastro do agente pelo backend. O modelo não escolhe UUID, socket ou caminho do host.

Cada VM tem 1 vCPU, 256 MiB de RAM e disco de trabalho ext4 de 256 MiB. O worker admite até quatro cadastros de máquina. O cgroup de cada VMM limita CPU a um núcleo, memória do processo a 384 MiB e tarefas a 64. O jailer usa chroot, namespace de PID e UID/GID numéricos distintos por agente. Seccomp permanece habilitado. O rootfs compartilhado é somente leitura. O disco de trabalho é exclusivo e conservado entre boots.

A microVM não tem interface de rede. O tráfego de ferramentas passa por seu socket vsock privado e inclui token e geração próprios daquele boot. O guest recusa outra geração. O socket do worker fica acessível apenas a root e ao UID do serviço de laboratório. A API pública continua autenticando o dono e a audiência Matrix antes de executar trabalho e publicar anexos.

## Arquivos e retomada

Os caminhos são relativos ao workspace, sem componentes ocultos, travessia ou symlinks. Arquivos UTF-8 são limitados a 64 KiB. Escritas usam arquivo temporário, rename e fsync. O guest persiste recibos por chamada Pi em SQLite no disco de trabalho. Uma repetição com o mesmo ID recupera seu recibo; argumentos diferentes são recusados.

O worker persiste o vínculo de máquina, o UID, o estado desejado/observado e o recibo do reinício. A geração do reinício é reservada antes da parada. Repetir a chamada não reinicia a máquina outra vez, mesmo após um reinício posterior. Na retomada do worker, o processo existente é reconciliado pelo PID, instante de início, UID e chroot. Saída inesperada cria outra geração na próxima recuperação.

Ao parar, o worker pede sincronização ao guest e encerra o VMM. O boot seguinte usa o mesmo disco ext4. Isso valida parada/início com persistência de disco. Snapshots e backup/restauração em destino novo seguem fora deste aceite.

`write_file` e `read_file` registram uma cópia verificada por SHA-256 na fila privada de anexos do serviço. O serviço criptografa o conteúdo, envia a mídia ao Matrix e publica `m.file` dentro do evento E2EE na DM. A fila guarda os metadados da mídia até confirmar a entrega e usa transação Matrix estável por chamada. Uma falha entre upload e persistência pode deixar uma mídia órfã, mas a repetição da publicação conserva o mesmo ID de transação. A cópia de conteúdo no outbox é apagada após a confirmação.

## Instalação no laboratório

`install-lab.sh` deve ser executado manualmente como root no Linux x86_64 autorizado. Ele instala o par oficial Firecracker/jailer 1.18.0, confere o SHA-256 publicado da distribuição e obtém o kernel 6.1.188 do artefato CI oficial datado de 05/11/2026. O guest é construído a partir de Alpine 3.23.2 com Python. Os hashes de kernel e rootfs resultantes são registrados em `assets.sha256`. O script recusa substituir ativos de uma instalação já inicializada.

O serviço host fica em `firecracker-lab.service`. Seu código e ativos ficam em `/opt/firecracker-lab`, o estado em `/var/lib/firecracker-lab` e o socket em `/run/firecracker-lab/worker.sock`. A instalação cria apenas o cgroup próprio do laboratório. Não configura interfaces, rotas, firewall ou serviços do restante do host. A ativação do serviço root no servidor compartilhado exige autorização explícita.

Após instalar o worker, ativar o override, de `apps/agents`.

```sh
docker compose -f compose.yaml -f compose.firecracker.yaml up -d --build agents
```

O container de agentes continua sem privilégios, sem acesso a KVM, ao Docker socket ou aos discos das VMs. Ele monta somente o diretório do socket de controle e conserva a autenticação do modelo em seu estado privado. Desativar o override devolve o serviço à configuração anterior. Para parar uma VM, usar a operação administrativa `stop` do worker com seu UUID. Os discos são conservados. Parar apenas o worker conserva VMMs em execução para reconciliação posterior.

## Testes

Testes de guest/worker que não exigem Linux/KVM.

```sh
python3 -m unittest discover -s apps/agents/firecracker -v
```

Os testes TypeScript do serviço cobrem o vínculo de máquina, validação do hash de conteúdo, integração das ferramentas com Pi e a fila persistente de anexos.

O teste Playwright existente aceita o cenário de máquina com `CLAWDIA_FIRECRACKER_TEST=1` e `CLAWDIA_REAL_MODEL_TEST=1`. Com laboratório ativo e as credenciais privadas de teste já configuradas, ele cria o agente pela interface, pede o arquivo por DM, baixa o anexo, solicita um reinício e recupera e baixa novamente o arquivo. Os bytes devem ser iguais e a sala deve ser a mesma.

```sh
BASE_URL=http://127.0.0.1:8088 CLAWDIA_MATRIX_TEST_CREDENTIALS=/caminho/privado/usuario-lab.json CLAWDIA_REAL_MODEL_TEST=1 CLAWDIA_FIRECRACKER_TEST=1 pnpm --filter element-web exec playwright test playwright/e2e/agents/live-onboarding.spec.ts --project=Chrome --ignore-snapshots
```

O verificador operacional `validate-lab.py` usa dois UUIDs de laboratório e o worker instalado para comprovar boot real, persistência por hash, recusa de leitura entre agentes e repetição idempotente do reinício. Ele mantém o disco do agente e para a máquina auxiliar ao final. Deve ser executado apenas no laboratório autorizado, após a instalação.

Registrar separadamente boot KVM real, UID/cgroup observados, hashes, boot IDs diferentes, isolamento entre dois agentes e o resultado do navegador. Testes locais com o worker simulado não comprovam execução em microVM.

Referências técnicas: [jailer 1.18.0](https://github.com/firecracker-microvm/firecracker/blob/v1.18.0/docs/jailer.md), [vsock 1.18.0](https://github.com/firecracker-microvm/firecracker/blob/v1.18.0/docs/vsock.md) e [getting started 1.18.0](https://github.com/firecracker-microvm/firecracker/blob/v1.18.0/docs/getting-started.md).

## Compatibilidade da renomeação

Os nomes canônicos são `firecracker-lab.service`, `/opt/firecracker-lab`, `/var/lib/firecracker-lab`, `/run/firecracker-lab` e `/sys/fs/cgroup/firecracker-lab`. Configuração explícita usa `FIRECRACKER_LAB_STATE`, `FIRECRACKER_LAB_ASSETS`, `FIRECRACKER_LAB_SOCKET`, `FIRECRACKER_LAB_CGROUP`, `FIRECRACKER_LAB_CLIENT_UID` e `FIRECRACKER_LAB_MAX_MACHINES`.

Se o estado anterior em `/var/lib/clawdia-fc-lab` existir sozinho, o worker conserva os caminhos antigos de estado, ativos, socket e cgroup. Se os dois estados padrão existirem, ele recusa escolher implicitamente: exigir `FIRECRACKER_LAB_STATE` explícito impede um registro vazio paralelo. As variáveis `CLAWDIA_FC_*` permanecem como fallback. Não se renomeiam IDs de máquinas, recibos persistidos ou o protocolo do rootfs existente.

O instalador recusa uma instalação anterior detectada; não executa migração, reinstalação ou substituição dos discos. Um ambiente já instalado conserva seu serviço e seus diretórios até uma migração operacional explicitamente autorizada. Para verificar esse ambiente, fornecer seu socket existente ao argumento `--socket` do verificador. Os testes de compatibilidade são locais e não abrem KVM.
