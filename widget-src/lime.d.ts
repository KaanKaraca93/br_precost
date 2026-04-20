declare module "lime" {
  export interface IWidgetContext {
    getElement(): JQuery;
    executeIonApiAsync(request: {
      method: string;
      url: string;
      data?: any;
      cache?: boolean;
      headers?: { [key: string]: string };
    }): {
      subscribe(
        onSuccess: (response: any) => void,
        onError?: (error: any) => void
      ): void;
    };
    receive(channel: string): {
      subscribe(
        onSuccess: (data: any) => void,
        onError?: (error: any) => void
      ): void;
    };
  }

  export interface IWidgetInstance {
    settingsSaved(): void;
    dispose?(): void;
  }

  export namespace Log {
    function debug(message: string): void;
    function error(message: string): void;
    function info(message: string): void;
  }
}

declare var $: JQueryStatic;
declare var jQuery: JQueryStatic;
