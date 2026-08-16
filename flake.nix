{
  description = "One Among Us Stripe donation backend";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs = { self, nixpkgs }:
    let
      supportedSystems = [ "x86_64-linux" "aarch64-linux" ];
      forAllSystems = function:
        nixpkgs.lib.genAttrs supportedSystems (system: function nixpkgs.legacyPackages.${system});
      mkPackage = pkgs: pkgs.stdenvNoCC.mkDerivation {
        pname = "oau-payment-backend";
        version = "1.0.0";
        src = self;
        dontBuild = true;
        installPhase = ''
          runHook preInstall
          install -Dm444 server.mjs $out/lib/oau-payment-backend/server.mjs
          runHook postInstall
        '';
      };
    in
    {
      packages = forAllSystems (pkgs: {
        default = mkPackage pkgs;
      });

      checks = forAllSystems (pkgs: {
        package = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      });

      nixosModules.default = { config, lib, pkgs, ... }:
        let
          cfg = config.services.oau-payment-backend;
        in
        {
          options.services.oau-payment-backend = {
            enable = lib.mkEnableOption "the One Among Us Stripe donation backend";

            package = lib.mkOption {
              type = lib.types.package;
              default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
              defaultText = lib.literalExpression "payment-backend.packages.\${pkgs.system}.default";
              description = "The payment backend package to run.";
            };

            environmentFile = lib.mkOption {
              type = lib.types.str;
              default = "/var/lib/secrets/payment-backend.env";
              description = "Root-readable environment file containing Stripe and Turnstile secrets.";
            };

            host = lib.mkOption {
              type = lib.types.str;
              default = "127.0.0.1";
              description = "Address on which the backend listens.";
            };

            port = lib.mkOption {
              type = lib.types.port;
              default = 3000;
              description = "Port on which the backend listens.";
            };

          };

          config = lib.mkIf cfg.enable {
            systemd.services.oau-payment-backend = {
              description = "One Among Us Stripe donation backend";
              wantedBy = [ "multi-user.target" ];
              after = [ "network-online.target" ];
              wants = [ "network-online.target" ];

              environment = {
                HOST = cfg.host;
                PORT = toString cfg.port;
              };

              serviceConfig = {
                Type = "simple";
                ExecStart = "${pkgs.nodejs_22}/bin/node ${cfg.package}/lib/oau-payment-backend/server.mjs";
                EnvironmentFile = cfg.environmentFile;
                DynamicUser = true;
                Restart = "on-failure";
              RestartSec = "5s";
              CapabilityBoundingSet = "";
              LockPersonality = true;
              NoNewPrivileges = true;
                PrivateDevices = true;
                PrivateTmp = true;
                ProtectClock = true;
                ProtectControlGroups = true;
                ProtectHome = true;
                ProtectHostname = true;
                ProtectKernelLogs = true;
                ProtectKernelModules = true;
                ProtectKernelTunables = true;
                ProtectSystem = "strict";
                RestrictAddressFamilies = [ "AF_INET" "AF_INET6" ];
                RestrictNamespaces = true;
                RestrictRealtime = true;
                SystemCallArchitectures = "native";
                UMask = "0077";
              };
            };
          };
        };
    };
}
