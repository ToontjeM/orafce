# The "migration workstation" and web UI in one image (AlmaLinux 9):
#   - Node 20 web app
#   - ora2pg 25 + DBD::Oracle + Oracle Instant Client    (path A tooling)
#   - EDB Migration Toolkit + Java + Oracle JDBC driver  (path B tooling)
#   - edb-psql, used for psql meta-commands and for replaying SQL files
FROM almalinux:9
ARG TARGETARCH
ARG ORA2PG_VERSION=25.0
ARG OJDBC_VERSION=23.5.0.24.07
ENV ORACLE_HOME=/opt/oracle/instantclient \
    LD_LIBRARY_PATH=/opt/oracle/instantclient \
    PATH=/usr/edb/as18/bin:$PATH

RUN --mount=type=secret,id=repo_token bash -c 'set -eu; \
    T=$(cat /run/secrets/repo_token); test -n "$T"; \
    curl -1sLf "https://downloads.enterprisedb.com/$T/enterprise/setup.rpm.sh" | bash >/dev/null 2>&1; \
    dnf install -y epel-release; \
    dnf module reset -y nodejs; dnf module enable -y nodejs:20; \
    dnf install -y --allowerasing nodejs java-17-openjdk-headless edb-migrationtoolkit edb-as18-server-client \
        perl perl-DBI perl-DBD-Pg perl-devel perl-ExtUtils-MakeMaker perl-Test-Simple \
        gcc make unzip tar gzip libaio which curl; \
    dnf clean all; rm -rf /var/cache/dnf /etc/yum.repos.d/*enterprisedb*.repo'

# Oracle Instant Client (basic + sdk) is only needed to compile and run DBD::Oracle.
RUN set -eux; \
    case "${TARGETARCH:-$(uname -m)}" in \
      arm64|aarch64) IC=linux-arm64 ;; \
      *)             IC=linuxx64 ;; \
    esac; \
    mkdir -p /opt/oracle /tmp/ic; cd /tmp/ic; \
    for p in basic sdk; do \
      curl -fsSLO "https://download.oracle.com/otn_software/linux/instantclient/instantclient-$p-$IC.zip"; \
      unzip -oq "instantclient-$p-$IC.zip"; \
    done; \
    mv instantclient_* /opt/oracle/instantclient; rm -rf /tmp/ic; \
    ln -sf /opt/oracle/instantclient/libclntsh.so.* /opt/oracle/instantclient/libclntsh.so || true; \
    echo /opt/oracle/instantclient > /etc/ld.so.conf.d/oracle.conf; ldconfig

RUN set -eux; \
    curl -fsSL https://cpanmin.us | perl - --notest DBD::Oracle; \
    curl -fsSL "https://github.com/darold/ora2pg/archive/refs/tags/v${ORA2PG_VERSION}.tar.gz" | tar xz -C /tmp; \
    cd /tmp/ora2pg-${ORA2PG_VERSION}; perl Makefile.PL; make; make install; \
    cd /; rm -rf /tmp/ora2pg-* /root/.cpanm; ora2pg --version

# JDBC drivers for the Migration Toolkit: Oracle's (source, from Maven Central)
# and EDB's (target, from the EDB repo).
RUN curl -fsSL -o /usr/edb/migrationtoolkit/lib/ojdbc8.jar \
      "https://repo1.maven.org/maven2/com/oracle/database/jdbc/ojdbc8/${OJDBC_VERSION}/ojdbc8-${OJDBC_VERSION}.jar"
RUN --mount=type=secret,id=repo_token bash -c 'set -eu; \
    T=$(cat /run/secrets/repo_token); test -n "$T"; \
    curl -1sLf "https://downloads.enterprisedb.com/$T/enterprise/setup.rpm.sh" | bash >/dev/null 2>&1; \
    dnf install -y edb-jdbc; \
    dnf clean all; rm -rf /var/cache/dnf /etc/yum.repos.d/*enterprisedb*.repo'; \
    ln -sf /usr/edb/jdbc/edb-jdbc18.jar /usr/edb/migrationtoolkit/lib/edb-jdbc18.jar

WORKDIR /usr/src/app
COPY package.json package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund
COPY . .
EXPOSE 8080
CMD ["node", "server.js"]
