import "react";

declare module "react" {
  interface ImgHTMLAttributes<T> {
    description?: string;
  }
}
