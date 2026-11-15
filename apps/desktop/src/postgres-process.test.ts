import { expect, it } from "vitest";
import { windowsCommandLine } from "./native-process.js";

it("quotes server options with spaces or empty values for the pg_ctl command line", () => {
  expect(
    windowsCommandLine([
      "-h",
      "127.0.0.1",
      "-p",
      "54321",
      "-c",
      "unix_socket_directories=",
      "-c",
      "dynamic_library_path=C:\\Users\\Thu Anh\\AppData\\Roaming\\VNBot\\native\\pg\\lib",
    ]),
  ).toBe(
    '-h 127.0.0.1 -p 54321 -c "unix_socket_directories=" -c "dynamic_library_path=C:\\Users\\Thu Anh\\AppData\\Roaming\\VNBot\\native\\pg\\lib"',
  );
});
