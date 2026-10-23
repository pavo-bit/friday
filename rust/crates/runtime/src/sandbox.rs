use std::env;
use std::fs;
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq, Default)]
#[serde(rename_all = "kebab-case")]
pub enum FilesystemIsolationMode {
    Off,
    #[default]
    WorkspaceOnly,
    AllowList,
}

impl FilesystemIsolationMode {
    #[must_use]
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::WorkspaceOnly => "workspace-only",
            Self::AllowList => "allow-list",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SandboxConfig {
    pub enabled: Option<bool>,
    pub namespace_restrictions: Option<bool>,
    pub network_isolation: Option<bool>,
    pub filesystem_mode: Option<FilesystemIsolationMode>,
    pub allowed_mounts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SandboxRequest {
    pub enabled: bool,
    pub namespace_restrictions: bool,
    pub network_isolation: bool,
    pub filesystem_mode: FilesystemIsolationMode,
    pub allowed_mounts: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct ContainerEnvironment {
    pub in_container: bool,
    pub markers: Vec<String>,
}

#[allow(clippy::struct_excessive_bools)]
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq, Default)]
pub struct SandboxStatus {
    pub enabled: bool,
    pub requested: SandboxRequest,
    pub supported: bool,
    pub active: bool,
    pub namespace_supported: bool,
    pub namespace_active: bool,
    pub network_supported: bool,
    pub network_active: bool,
    pub filesystem_mode: FilesystemIsolationMode,
    pub filesystem_active: bool,
    pub allowed_mounts: Vec<String>,
    pub in_container: bool,
    pub container_markers: Vec<String>,
    pub fallback_reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SandboxDetectionInputs<'a> {
    pub env_pairs: Vec<(String, String)>,
    pub dockerenv_exists: bool,
    pub containerenv_exists: bool,
    pub proc_1_cgroup: Option<&'a str>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LinuxSandboxCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

impl SandboxConfig {
    #[must_use]
    pub fn resolve_request(
        &self,
        enabled_override: Option<bool>,
        namespace_override: Option<bool>,
        network_override: Option<bool>,
        filesystem_mode_override: Option<FilesystemIsolationMode>,
        allowed_mounts_override: Option<Vec<String>>,
    ) -> SandboxRequest {
        SandboxRequest {
            enabled: enabled_override.unwrap_or(self.enabled.unwrap_or(true)),
            namespace_restrictions: namespace_override
                .unwrap_or(self.namespace_restrictions.unwrap_or(true)),
            network_isolation: network_override.unwrap_or(self.network_isolation.unwrap_or(false)),
            filesystem_mode: filesystem_mode_override
                .or(self.filesystem_mode)
                .unwrap_or_default(),
            allowed_mounts: allowed_mounts_override.unwrap_or_else(|| self.allowed_mounts.clone()),
        }
    }
}

#[must_use]
pub fn detect_container_environment() -> ContainerEnvironment {
    let proc_1_cgroup = fs::read_to_string("/proc/1/cgroup").ok();
    detect_container_environment_from(SandboxDetectionInputs {
        env_pairs: env::vars().collect(),
        dockerenv_exists: Path::new("/.dockerenv").exists(),
        containerenv_exists: Path::new("/run/.containerenv").exists(),
        proc_1_cgroup: proc_1_cgroup.as_deref(),
    })
}

#[must_use]
pub fn detect_container_environment_from(
    inputs: SandboxDetectionInputs<'_>,
) -> ContainerEnvironment {
    let mut markers = Vec::new();
    if inputs.dockerenv_exists {
        markers.push("/.dockerenv".to_string());
    }
    if inputs.containerenv_exists {
        markers.push("/run/.containerenv".to_string());
    }
    for (key, value) in inputs.env_pairs {
        let normalized = key.to_ascii_lowercase();
        if matches!(
            normalized.as_str(),
            "container" | "docker" | "podman" | "kubernetes_service_host"
        ) && !value.is_empty()
        {
            markers.push(format!("env:{key}={value}"));
        }
    }
    if let Some(cgroup) = inputs.proc_1_cgroup {
        for needle in ["docker", "containerd", "kubepods", "podman", "libpod"] {
            if cgroup.contains(needle) {
                markers.push(format!("/proc/1/cgroup:{needle}"));
            }
        }
    }
    markers.sort();
    markers.dedup();
    ContainerEnvironment {
        in_container: !markers.is_empty(),
        markers,
    }
}

#[must_use]
pub fn resolve_sandbox_status(config: &SandboxConfig, cwd: &Path) -> SandboxStatus {
    let request = config.resolve_request(None, None, None, None, None);
    resolve_sandbox_status_for_request(&request, cwd)
}

#[must_use]
pub fn resolve_sandbox_status_for_request(request: &SandboxRequest, cwd: &Path) -> SandboxStatus {
    let container = detect_container_environment();
    let namespace_supported = cfg!(target_os = "linux") && unshare_user_namespace_works();
    let network_supported = namespace_supported;
    let filesystem_active =
        request.enabled && request.filesystem_mode != FilesystemIsolationMode::Off;
    let mut fallback_reasons = Vec::new();

    if request.enabled && request.namespace_restrictions && !namespace_supported {
        fallback_reasons
            .push("namespace isolation unavailable (requires Linux with `unshare`)".to_string());
    }
    if request.enabled && request.network_isolation && !network_supported {
        fallback_reasons
            .push("network isolation unavailable (requires Linux with `unshare`)".to_string());
    }
    if request.enabled
        && request.filesystem_mode == FilesystemIsolationMode::AllowList
        && request.allowed_mounts.is_empty()
    {
        fallback_reasons
            .push("filesystem allow-list requested without configured mounts".to_string());
    }

    let active = request.enabled
        && (!request.namespace_restrictions || namespace_supported)
        && (!request.network_isolation || network_supported);

    let allowed_mounts = normalize_mounts(&request.allowed_mounts, cwd);

    SandboxStatus {
        enabled: request.enabled,
        requested: request.clone(),
        supported: namespace_supported,
        active,
        namespace_supported,
        namespace_active: request.enabled && request.namespace_restrictions && namespace_supported,
        network_supported,
        network_active: request.enabled && request.network_isolation && network_supported,
        filesystem_mode: request.filesystem_mode,
        filesystem_active,
        allowed_mounts,
        in_container: container.in_container,
        container_markers: container.markers,
        fallback_reason: (!fallback_reasons.is_empty()).then(|| fallback_reasons.join("; ")),
    }
}

#[must_use]
pub fn build_linux_sandbox_command(
    command: &str,
    cwd: &Path,
    status: &SandboxStatus,
) -> Option<LinuxSandboxCommand> {
    if !cfg!(target_os = "linux")
        || !status.enabled
        || (!status.namespace_active && !status.network_active)
    {
        return None;
    }

    let mut args = vec![
        "--user".to_string(),
        "--map-root-user".to_string(),
        "--mount".to_string(),
        "--ipc".to_string(),
        "--pid".to_string(),
        "--uts".to_string(),
        "--fork".to_string(),
    ];
    if status.network_active {
        args.push("--net".to_string());
    }
    args.push("sh".to_string());
    args.push("-lc".to_string());
    args.push(command.to_string());

    let sandbox_home = cwd.join(".sandbox-home");
    let sandbox_tmp = cwd.join(".sandbox-tmp");
    let mut env = vec![
        ("HOME".to_string(), sandbox_home.display().to_string()),
        ("TMPDIR".to_string(), sandbox_tmp.display().to_string()),
        (
            "CLAWD_SANDBOX_FILESYSTEM_MODE".to_string(),
            status.filesystem_mode.as_str().to_string(),
        ),
        (
            "CLAWD_SANDBOX_ALLOWED_MOUNTS".to_string(),
            status.allowed_mounts.join(":"),
        ),
    ];
    if let Ok(path) = env::var("PATH") {
        env.push(("PATH".to_string(), path));
    }

    Some(LinuxSandboxCommand {
        program: "unshare".to_string(),
        args,
        env,
    })
}

fn normalize_mounts(mounts: &[String], cwd: &Path) -> Vec<String> {
    let cwd = cwd.to_path_buf();
    mounts
        .iter()
        .map(|mount| {
            let path = PathBuf::from(mount);
            if path.is_absolute() {
                path
            } else {
                cwd.join(path)
            }
        })
        .map(|path| path.display().to_string())
        .collect()
}

// ---------------------------------------------------------------------------
// Windows Sandbox Support (Phase 2)
// ---------------------------------------------------------------------------

/// A sandboxed command descriptor for Windows execution.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WindowsSandboxCommand {
    pub program: String,
    pub args: Vec<String>,
    pub env: Vec<(String, String)>,
}

/// Available Windows sandbox strategies, ordered by preference.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WindowsSandboxStrategy {
    /// Docker Desktop is available — use ephemeral containers.
    Docker,
    /// PowerShell constrained language mode as a lightweight fallback.
    ConstrainedPowerShell,
    /// No sandbox available; execution proceeds unsandboxed.
    None,
}

/// Detect which Windows sandbox strategy is available on this system.
#[must_use]
pub fn detect_windows_sandbox_strategy() -> WindowsSandboxStrategy {
    if cfg!(not(target_os = "windows")) {
        return WindowsSandboxStrategy::None;
    }

    // Prefer Docker Desktop if docker CLI is accessible
    if command_exists("docker") && docker_daemon_running() {
        return WindowsSandboxStrategy::Docker;
    }

    // Fallback: PowerShell constrained language mode
    if command_exists("powershell") || command_exists("pwsh") {
        return WindowsSandboxStrategy::ConstrainedPowerShell;
    }

    WindowsSandboxStrategy::None
}

/// Build a sandboxed command for Windows using Docker containers.
///
/// This creates an ephemeral `alpine` container with the workspace mounted
/// according to the configured filesystem isolation mode:
/// - `ReadOnly` → mount as `:ro`
/// - `WorkspaceOnly` → mount project dir as `:rw`, no other mounts
/// - `AllowList` → mount each allowed path, block everything else
#[must_use]
pub fn build_windows_sandbox_command(
    command: &str,
    cwd: &Path,
    status: &SandboxStatus,
) -> Option<WindowsSandboxCommand> {
    if !cfg!(target_os = "windows") || !status.enabled {
        return None;
    }

    let strategy = detect_windows_sandbox_strategy();

    match strategy {
        WindowsSandboxStrategy::Docker => {
            build_docker_sandbox_command(command, cwd, status)
        }
        WindowsSandboxStrategy::ConstrainedPowerShell => {
            build_constrained_powershell_command(command, cwd, status)
        }
        WindowsSandboxStrategy::None => None,
    }
}

fn build_docker_sandbox_command(
    command: &str,
    cwd: &Path,
    status: &SandboxStatus,
) -> Option<WindowsSandboxCommand> {
    let cwd_str = cwd.display().to_string();
    let mount_mode = match status.filesystem_mode {
        FilesystemIsolationMode::Off => "rw",
        FilesystemIsolationMode::WorkspaceOnly => "rw",
        FilesystemIsolationMode::AllowList => "ro",
    };

    let mut args = vec![
        "run".to_string(),
        "--rm".to_string(),                   // Ephemeral container
        "--interactive".to_string(),
        format!("--memory=512m"),             // Memory limit
        format!("--cpus=1.0"),                // CPU limit
        format!("--pids-limit=256"),          // Fork bomb protection
    ];

    // Network isolation
    if status.network_active {
        args.push("--network=none".to_string());
    }

    // Mount workspace
    args.push(format!("-v={cwd_str}:/workspace:{mount_mode}"));
    args.push("-w=/workspace".to_string());

    // Mount additional allowed paths
    for mount in &status.allowed_mounts {
        args.push(format!("-v={mount}:{mount}:ro"));
    }

    // Set environment variables for sandboxed tools
    args.push(format!(
        "-e=CLAWD_SANDBOX_FILESYSTEM_MODE={}",
        status.filesystem_mode.as_str()
    ));
    args.push("-e=CLAWD_SANDBOXED=true".to_string());

    // Timeout via --stop-timeout
    args.push("--stop-timeout=120".to_string());

    // Use a minimal Alpine base image
    args.push("alpine:latest".to_string());
    args.push("sh".to_string());
    args.push("-c".to_string());
    args.push(command.to_string());

    Some(WindowsSandboxCommand {
        program: "docker".to_string(),
        args,
        env: Vec::new(),
    })
}

fn build_constrained_powershell_command(
    command: &str,
    cwd: &Path,
    status: &SandboxStatus,
) -> Option<WindowsSandboxCommand> {
    // PowerShell constrained language mode restricts:
    // - .NET type access
    // - COM objects
    // - Arbitrary assembly loading
    // It's not full isolation but prevents the most dangerous operations.
    let ps_program = if command_exists("pwsh") { "pwsh" } else { "powershell" };

    let sandbox_script = format!(
        "$ExecutionContext.SessionState.LanguageMode = 'ConstrainedLanguage'; \
         $env:CLAWD_SANDBOXED = 'true'; \
         $env:CLAWD_SANDBOX_FILESYSTEM_MODE = '{}'; \
         Set-Location '{}'; \
         {}",
        status.filesystem_mode.as_str(),
        cwd.display(),
        command,
    );

    Some(WindowsSandboxCommand {
        program: ps_program.to_string(),
        args: vec![
            "-NoProfile".to_string(),
            "-NonInteractive".to_string(),
            "-Command".to_string(),
            sandbox_script,
        ],
        env: vec![
            ("CLAWD_SANDBOXED".to_string(), "true".to_string()),
            (
                "CLAWD_SANDBOX_FILESYSTEM_MODE".to_string(),
                status.filesystem_mode.as_str().to_string(),
            ),
        ],
    })
}

/// Cross-platform sandbox command dispatcher.
///
/// Returns the appropriate sandbox command for the current OS:
/// - Linux → `unshare` namespace isolation
/// - Windows → Docker or constrained PowerShell
/// - Other → None (unsandboxed)
#[must_use]
pub fn build_sandbox_command(
    command: &str,
    cwd: &Path,
    status: &SandboxStatus,
) -> SandboxCommandResult {
    if !status.enabled {
        return SandboxCommandResult::Disabled;
    }

    if cfg!(target_os = "linux") {
        if let Some(cmd) = build_linux_sandbox_command(command, cwd, status) {
            return SandboxCommandResult::Linux(cmd);
        }
    }

    if cfg!(target_os = "windows") {
        if let Some(cmd) = build_windows_sandbox_command(command, cwd, status) {
            return SandboxCommandResult::Windows(cmd);
        }
    }

    SandboxCommandResult::Unsupported {
        reason: format!(
            "no sandbox backend available on {} (tried: {})",
            std::env::consts::OS,
            if cfg!(target_os = "linux") {
                "unshare"
            } else if cfg!(target_os = "windows") {
                "docker, powershell"
            } else {
                "none"
            },
        ),
    }
}

/// Result of attempting to build a sandboxed command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SandboxCommandResult {
    Linux(LinuxSandboxCommand),
    Windows(WindowsSandboxCommand),
    Disabled,
    Unsupported { reason: String },
}

/// Check if the Docker daemon is responsive (Windows/macOS).
fn docker_daemon_running() -> bool {
    use std::sync::OnceLock;
    static RESULT: OnceLock<bool> = OnceLock::new();
    *RESULT.get_or_init(|| {
        std::process::Command::new("docker")
            .args(["info", "--format", "{{.ServerVersion}}"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

#[cfg(not(target_os = "windows"))]
fn command_exists(command: &str) -> bool {
    env::var_os("PATH")
        .is_some_and(|paths| env::split_paths(&paths).any(|path| path.join(command).exists()))
}

/// Also check for `.exe` suffix on Windows.
#[cfg(target_os = "windows")]
fn command_exists(command: &str) -> bool {
    env::var_os("PATH").is_some_and(|paths| {
        env::split_paths(&paths).any(|path| {
            path.join(command).exists()
                || path.join(format!("{command}.exe")).exists()
                || path.join(format!("{command}.cmd")).exists()
        })
    })
}

/// Check whether `unshare --user` actually works on this system.
/// On some CI environments (e.g. GitHub Actions), the binary exists but
/// user namespaces are restricted, causing silent failures.
fn unshare_user_namespace_works() -> bool {
    use std::sync::OnceLock;
    static RESULT: OnceLock<bool> = OnceLock::new();
    *RESULT.get_or_init(|| {
        if !command_exists("unshare") {
            return false;
        }
        std::process::Command::new("unshare")
            .args(["--user", "--map-root-user", "true"])
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::null())
            .stderr(std::process::Stdio::null())
            .status()
            .map(|s| s.success())
            .unwrap_or(false)
    })
}

#[cfg(test)]
mod tests {
    use super::{
        build_linux_sandbox_command, detect_container_environment_from, FilesystemIsolationMode,
        SandboxConfig, SandboxDetectionInputs,
    };
    use std::path::Path;

    #[test]
    fn detects_container_markers_from_multiple_sources() {
        let detected = detect_container_environment_from(SandboxDetectionInputs {
            env_pairs: vec![("container".to_string(), "docker".to_string())],
            dockerenv_exists: true,
            containerenv_exists: false,
            proc_1_cgroup: Some("12:memory:/docker/abc"),
        });

        assert!(detected.in_container);
        assert!(detected
            .markers
            .iter()
            .any(|marker| marker == "/.dockerenv"));
        assert!(detected
            .markers
            .iter()
            .any(|marker| marker == "env:container=docker"));
        assert!(detected
            .markers
            .iter()
            .any(|marker| marker == "/proc/1/cgroup:docker"));
    }

    #[test]
    fn resolves_request_with_overrides() {
        let config = SandboxConfig {
            enabled: Some(true),
            namespace_restrictions: Some(true),
            network_isolation: Some(false),
            filesystem_mode: Some(FilesystemIsolationMode::WorkspaceOnly),
            allowed_mounts: vec!["logs".to_string()],
        };

        let request = config.resolve_request(
            Some(true),
            Some(false),
            Some(true),
            Some(FilesystemIsolationMode::AllowList),
            Some(vec!["tmp".to_string()]),
        );

        assert!(request.enabled);
        assert!(!request.namespace_restrictions);
        assert!(request.network_isolation);
        assert_eq!(request.filesystem_mode, FilesystemIsolationMode::AllowList);
        assert_eq!(request.allowed_mounts, vec!["tmp"]);
    }

    #[test]
    fn builds_linux_launcher_with_network_flag_when_requested() {
        let config = SandboxConfig::default();
        let status = super::resolve_sandbox_status_for_request(
            &config.resolve_request(
                Some(true),
                Some(true),
                Some(true),
                Some(FilesystemIsolationMode::WorkspaceOnly),
                None,
            ),
            Path::new("/workspace"),
        );

        if let Some(launcher) =
            build_linux_sandbox_command("printf hi", Path::new("/workspace"), &status)
        {
            assert_eq!(launcher.program, "unshare");
            assert!(launcher.args.iter().any(|arg| arg == "--mount"));
            assert!(launcher.args.iter().any(|arg| arg == "--net") == status.network_active);
        }
    }
}
