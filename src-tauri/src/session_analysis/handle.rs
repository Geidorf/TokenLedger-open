//! Validate the opened handle itself, not merely a pathname checked earlier.
use super::types::Failure;
use std::{fs::File, path::PathBuf};

#[cfg(windows)]
#[repr(C)]
struct FileTime {
    low: u32,
    high: u32,
}
#[cfg(windows)]
#[repr(C)]
struct FileInformation {
    attributes: u32,
    creation: FileTime,
    access: FileTime,
    write: FileTime,
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[cfg(windows)]
#[link(name = "kernel32")]
unsafe extern "system" {
    fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut FileInformation)
        -> i32;
    fn GetFinalPathNameByHandleW(
        handle: *mut std::ffi::c_void,
        path: *mut u16,
        size: u32,
        flags: u32,
    ) -> u32;
}

#[cfg(windows)]
pub(super) fn identity_and_path(file: &File) -> Result<(String, PathBuf), Failure> {
    use std::{
        mem::MaybeUninit,
        os::windows::{ffi::OsStringExt, io::AsRawHandle},
    };
    let mut info = MaybeUninit::<FileInformation>::uninit();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } == 0 {
        return Err("source_unreadable");
    }
    let info = unsafe { info.assume_init() };
    let identity = format!(
        "windows:{}:{}",
        info.volume,
        (u64::from(info.index_high) << 32) | u64::from(info.index_low)
    );
    let mut path = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            path.as_mut_ptr(),
            path.len() as u32,
            0,
        )
    } as usize;
    if length == 0 || length >= path.len() {
        return Err("source_unreadable");
    }
    Ok((
        identity,
        PathBuf::from(std::ffi::OsString::from_wide(&path[..length])),
    ))
}

#[cfg(unix)]
pub(super) fn identity_and_path(file: &File) -> Result<(String, PathBuf), Failure> {
    use std::os::unix::{fs::MetadataExt, io::AsRawFd};
    let metadata = file.metadata().map_err(|_| "source_unreadable")?;
    let identity = format!("unix:{}:{}", metadata.dev(), metadata.ino());
    #[cfg(target_os = "linux")]
    let path = std::fs::read_link(format!("/proc/self/fd/{}", file.as_raw_fd()))
        .map_err(|_| "source_unreadable")?;
    #[cfg(target_os = "macos")]
    let path = {
        use std::os::unix::ffi::OsStringExt;
        unsafe extern "C" {
            fn fcntl(fd: i32, command: i32, ...) -> i32;
        }
        let mut bytes = [0u8; 1024];
        // F_GETPATH is the Darwin descriptor-to-path operation.
        if unsafe { fcntl(file.as_raw_fd(), 50, bytes.as_mut_ptr()) } == -1 {
            return Err("source_unreadable");
        }
        let length = bytes
            .iter()
            .position(|byte| *byte == 0)
            .ok_or("source_unreadable")?;
        PathBuf::from(std::ffi::OsString::from_vec(bytes[..length].to_vec()))
    };
    #[cfg(not(any(target_os = "linux", target_os = "macos")))]
    let path: PathBuf = return Err("source_unreadable");
    Ok((identity, path))
}

#[cfg(not(any(unix, windows)))]
pub(super) fn identity_and_path(_file: &File) -> Result<(String, PathBuf), Failure> {
    Err("source_unreadable")
}
