/* eslint-disable jsx-a11y/anchor-is-valid */
import React from "react";

import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { Routes, Route, Navigate } from "react-router-dom";

import { BrowserRouter } from "react-router-dom";

import { CssVarsProvider } from "@mui/joy/styles";

import GlobalStyles from "@mui/joy/GlobalStyles";
import CssBaseline from "@mui/joy/CssBaseline";

import Box from "@mui/joy/Box";
import Container from "@mui/joy/Container";

const queryClient = new QueryClient();

import Header from "./components/Header";
import Instances from "./pages/Instances";
import Communities from "./pages/Communities";

import customTheme from "./theme";

export default function App() {
  return (
    <CssVarsProvider defaultMode="dark" disableTransitionOnChange theme={customTheme}>
      <CssBaseline />
      <QueryClientProvider client={queryClient}>
        <Container
          maxWidth={false}
          disableGutters={true}
          sx={{
            height: "100%",
            width: "100%",
            position: "absolute",
            bottom: 0,
            top: 0,
            left: 0,
            right: 0,
            display: "block",
            overflow: "hidden",
          }}
        >
          <BrowserRouter>
            <Header />
            <Box sx={{ overflow: "auto", height: "calc(100% - 80px)" }}>
              <Routes>
                <Route
                  index
                  //   path="/instances"
                  element={<Instances />}
                />
                <Route path="/communities" element={<Communities />} />
                <Route path="/communities/:instanceBaseUrl" element={<Communities />} />
                {/* <Route path="*" element={<NoMatch />} /> */}
              </Routes>
            </Box>
          </BrowserRouter>
        </Container>
      </QueryClientProvider>
    </CssVarsProvider>
  );
}

const rootElement = document.getElementById("root");
ReactDOM.createRoot(rootElement).render(<App />);
